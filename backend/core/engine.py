"""The Neighbourhood Flex closed loop, one 15-minute interval per tick.

SENSE      simulate the 20 smart meters and the transformer meter
VALIDATE   the edge gateway repairs and flags bad readings
MEASURE    compare the transformer with the sum of meters
FORECAST   demand and solar for the next 60 minutes, per phase
DETECT     compare forecast net load with the transformer limits
PLAN       time-shift eligible load; recommend phase rebalancing
DISPATCH   send household requests (auto, or after operator approval)
VERIFY     compare planned, delivered and measured response
ESCALATE   report residual risk to the utility
"""

from collections import deque
from typing import Any, Optional

import numpy as np

from config import (
    FORECAST_BAND_Z,
    FORECAST_HORIZON_STEPS,
    HISTORY_WINDOW_INTERVALS,
    INTERVAL_MINUTES,
    INTERVALS_PER_DAY,
    PEAK_WINDOW_HOURS,
    PENDING_ACTION_EXPIRY_INTERVALS,
    PHASE_ACTION_COOLDOWN_INTERVALS,
    PHASE_CREW_DELAY_INTERVALS,
    PHASE_IMBALANCE_TRIGGER_PCT,
    PHASE_LIMIT_KW,
    RANDOM_SEED,
    SAFE_LIMIT_KW,
    SECONDS_PER_INTERVAL,
    SHIFT_SAFETY_MARGIN,
    TRANSFORMER_RATING_KVA,
    VALLEY_TARGET_FRACTION,
)
from core.flexibility import (
    SHIFTABLE_CLASSES,
    ShiftPlan,
    assess_gap,
    imbalance_pct,
    plan_phase_rebalance,
    plan_time_shift,
)
from core.forecasting import FEATURE_NAMES, DemandForecaster
from core.gateway import EdgeGateway
from core.households import LOAD_CLASSES, PHASES, ApplianceEvent, base_components, generate_events
from core.transformer import consistency_check, expected_transformer_kw, measure
from core.world import World, build_world

WEEK = 7 * INTERVALS_PER_DAY


def _round(value: float, digits: int = 2) -> float:
    return round(float(value), digits)


class FlexEngine:
    def __init__(self):
        self.world: World = build_world()
        self.houses = {house.house_id: house for house in self.world.houses}
        self.rng = np.random.default_rng(RANDOM_SEED + 1)
        self.meter_rng = np.random.default_rng(RANDOM_SEED + 3)
        self.gateway = EdgeGateway(rng=np.random.default_rng(RANDOM_SEED + 2))
        self.forecaster = DemandForecaster(FORECAST_HORIZON_STEPS)
        self.forecaster.fit(self.world.phase_demand, self.world.now_index, self.world.calendar)
        # Demand as it would have been without any shifting: the forecaster's input,
        # so planned shifts are applied once, on top of the forecast.
        self.house_shift_diff = np.zeros((len(self.world.houses), self.world.size))
        self.baseline_demand = {phase: self.world.phase_demand[phase].copy() for phase in PHASES}

        self.index = self.world.now_index  # next interval to simulate
        self.running = False
        self.seconds_per_interval = SECONDS_PER_INTERVAL
        self.config = {
            "safe_limit_kw": SAFE_LIMIT_KW,
            "phase_limit_kw": PHASE_LIMIT_KW,
            "auto_dispatch": True,
            "temperature_offset_c": 0.0,
        }

        self.events: dict[str, ApplianceEvent] = {}
        self.generated_days: set[int] = set()
        self.planned_delta: dict[str, dict[int, float]] = {phase: {} for phase in PHASES}
        self.baseline_profiles: dict[str, dict[int, float]] = {}  # default draw of shifted events
        self.actions: list[dict] = []
        self.escalations: list[dict] = []
        self.next_id = 1
        self.last_phase_action_index = -PHASE_ACTION_COOLDOWN_INTERVALS
        self.history: deque = deque(maxlen=HISTORY_WINDOW_INTERVALS)
        self.forecast_log: dict[int, dict[str, float]] = {}
        self.live_errors: deque = deque(maxlen=INTERVALS_PER_DAY)
        self.totals = {
            "intervals": 0,
            "intervals_over_limit": 0,
            "intervals_over_limit_without": 0,
            "requests_sent": 0,
            "requests_accepted": 0,
            "requests_declined": 0,
            "energy_shifted_kwh": 0.0,
            "escalations": 0,
            "meter_issues": 0,
        }
        self.current: dict[str, Any] = {}
        self._seed_history()
        self.tick()

    # ------------------------------------------------------------------ helpers

    def _new_id(self, prefix: str) -> str:
        identifier = f"{prefix}-{self.next_id}"
        self.next_id += 1
        return identifier

    def _time(self, index: int) -> str:
        return self.world.timestamp(index).isoformat(timespec="minutes")

    def _ensure_events(self, index: int):
        day = index // INTERVALS_PER_DAY
        for target_day in (day, day + 1):
            if target_day in self.generated_days:
                continue
            self.generated_days.add(target_day)
            weekend = bool(self.world.weekend[min(target_day * INTERVALS_PER_DAY, self.world.size - 1)])
            for house in self.world.houses:
                for event in generate_events(
                    house, target_day, weekend, self.world.morning_temperature(target_day), RANDOM_SEED
                ):
                    # Events that started before the live simulation are already in history.
                    if event.default_start >= self.world.now_index:
                        self.events[event.event_id] = event
        # Forget finished events after a day.
        stale = [key for key, event in self.events.items() if event.status == "done" and event.deadline < index - INTERVALS_PER_DAY]
        for key in stale:
            self.events.pop(key)

    def _seed_history(self):
        """Fill the chart with the last day of history before the simulation starts."""
        for index in range(self.index - HISTORY_WINDOW_INTERVALS, self.index):
            total = float(self.world.transformer_total[index])
            self.history.append(
                {
                    "time": self._time(index),
                    "total_kw": _round(total),
                    "without_kw": _round(total),
                    "phases": {phase: _round(self.world.transformer_phase[phase][index]) for phase in PHASES},
                    "forecast_kw": None,
                    "limit_kw": self.config["safe_limit_kw"],
                    "simulated": False,
                }
            )

    def _phase_members(self, phase: str) -> list[int]:
        return [i for i, house in enumerate(self.world.houses) if house.phase == phase]

    def _profile_phase(self, index: int, phase: str) -> float:
        """Expected transformer load on a phase at a future interval: average of the last 7 days."""
        members = self._phase_members(phase)
        hour = float(self.world.hour[index])
        samples = []
        for day in range(1, 8):
            past = index - day * INTERVALS_PER_DAY
            if past < self.index:
                samples.append(float(expected_transformer_kw(self.world.house_net[members, past].sum(), hour)))
        return float(np.mean(samples)) if samples else 0.0

    def _profile_total(self, index: int) -> float:
        return sum(self._profile_phase(index, phase) for phase in PHASES)

    def _planned_add(self) -> tuple[dict[int, float], dict[str, dict[int, float]]]:
        add_phase = {phase: {k: v for k, v in self.planned_delta[phase].items() if v > 0} for phase in PHASES}
        add_total: dict[int, float] = {}
        for phase in PHASES:
            for index, value in add_phase[phase].items():
                add_total[index] = add_total.get(index, 0.0) + value
        return add_total, add_phase

    # --------------------------------------------------------------------- tick

    def tick(self):
        i = self.index
        if i + FORECAST_HORIZON_STEPS + INTERVALS_PER_DAY >= self.world.size:
            self.running = False
            return
        world = self.world
        self._ensure_events(i)
        hour = float(world.hour[i])
        offset = self.config["temperature_offset_c"]
        temperature = float(world.weather.temperature_c[i]) + offset

        # SENSE: true demand per house, split by protection class.
        by_class = {load_class: 0.0 for load_class in LOAD_CLASSES}
        consumption: dict[str, float] = {}
        generation: dict[str, float] = {}
        running_by_house: dict[str, list[str]] = {}
        event_kw_by_house: dict[str, dict[str, float]] = {house_id: {"flexible": 0.0, "highly_deferrable": 0.0} for house_id in self.houses}
        for event in self.events.values():
            kw = event.draw(i)
            if kw > 0:
                event_kw_by_house[event.house_id][event.load_class] += kw
                running_by_house.setdefault(event.house_id, []).append(event.label)

        for row, house in enumerate(world.houses):
            critical, essential = base_components(
                house,
                world.hour[i : i + 1],
                world.weekend[i : i + 1],
                world.weather.temperature_c[i : i + 1] + offset,
                world.noise[row, i : i + 1],
            )
            flexible = event_kw_by_house[house.house_id]["flexible"]
            deferrable = event_kw_by_house[house.house_id]["highly_deferrable"]
            by_class["critical"] += float(critical[0])
            by_class["essential"] += float(essential[0])
            by_class["flexible"] += flexible
            by_class["highly_deferrable"] += deferrable
            consumption[house.house_id] = float(critical[0] + essential[0]) + flexible + deferrable
            generation[house.house_id] = float(world.generation[row, i])

        # VALIDATE at the edge gateway.
        gateway = self.gateway.process(i, self._time(i), world.houses, consumption, generation)
        for row, reading in enumerate(gateway.readings):
            world.house_net[row, i] = reading.net_kw
        for phase in PHASES:
            world.phase_demand[phase][i] = gateway.phase_consumption_kw[phase]
        issues = sum(count for flag, count in gateway.counts.items() if flag != "ok")
        self.totals["meter_issues"] += issues

        # MEASURE at the transformer (physical truth, not the cleaned meter data).
        true_phase_net = {phase: 0.0 for phase in PHASES}
        for house in world.houses:
            true_phase_net[house.phase] += consumption[house.house_id] - generation[house.house_id]
        transformer = measure(true_phase_net, hour, self.meter_rng)
        for phase in PHASES:
            world.transformer_phase[phase][i] = transformer[phase]["kw"]
        total_kw = sum(transformer[phase]["kw"] for phase in PHASES)
        world.transformer_total[i] = total_kw
        meter_phase_net = {
            phase: gateway.phase_consumption_kw[phase] - gateway.phase_generation_kw[phase] for phase in PHASES
        }
        consistency = consistency_check(total_kw, meter_phase_net, hour, flagged_readings=issues)

        # Without coordination: add back the default draw of every shifted appliance.
        rows = {house.house_id: row for row, house in enumerate(world.houses)}
        for event_id, profile in self.baseline_profiles.items():
            event = self.events.get(event_id)
            if event is not None:
                self.house_shift_diff[rows[event.house_id], i] += profile.get(i, 0.0) - event.history.get(i, 0.0)
        without_phase = {phase: transformer[phase]["kw"] for phase in PHASES}
        for phase in PHASES:
            difference = float(self.house_shift_diff[self._phase_members(phase), i].sum())
            without_phase[phase] += difference
            self.baseline_demand[phase][i] = world.phase_demand[phase][i] + difference
        without_total = sum(without_phase.values())

        limit = self.config["safe_limit_kw"]
        phase_limit = self.config["phase_limit_kw"]
        self.totals["intervals"] += 1
        if total_kw > limit or any(transformer[p]["kw"] > phase_limit for p in PHASES):
            self.totals["intervals_over_limit"] += 1
        if without_total > limit or any(without_phase[p] > phase_limit for p in PHASES):
            self.totals["intervals_over_limit_without"] += 1

        logged = self.forecast_log.pop(i, None)
        if logged is not None:
            self.live_errors.append(abs(logged["baseline"] + logged["planned"] - total_kw))

        # VERIFY earlier actions and execute scheduled phase changes.
        self._verify_actions(i)
        self._execute_phase_changes(i)

        # FORECAST the next hour from data up to and including interval i.
        forecast = self._forecast(i, offset)
        adjusted = {h: forecast[h]["adjusted_phase"] for h in forecast}
        self.forecast_log[i + 1] = {
            "baseline": forecast[1]["baseline_total"],
            "planned": forecast[1]["adjusted_total"] - forecast[1]["baseline_total"],
        }

        # DETECT and PLAN.
        self._expire_pending(i)
        gap = assess_gap(adjusted, limit, phase_limit)
        plan_summary = None
        if gap.any_gap:
            plan_summary = self._plan_time_shift(i, gap, forecast)
        self._consider_phase_rebalance(i, gap)

        self.history.append(
            {
                "time": self._time(i),
                "total_kw": _round(total_kw),
                "without_kw": _round(without_total),
                "phases": {phase: _round(transformer[phase]["kw"]) for phase in PHASES},
                "forecast_kw": _round(logged["baseline"] + logged["planned"]) if logged else None,
                "limit_kw": limit,
                "simulated": True,
            }
        )

        self.current = {
            "index": i,
            "hour": hour,
            "temperature": temperature,
            "transformer": transformer,
            "total_kw": total_kw,
            "without_total": without_total,
            "without_phase": without_phase,
            "consistency": consistency,
            "gateway": gateway,
            "by_class": by_class,
            "consumption": consumption,
            "generation": generation,
            "running_by_house": running_by_house,
            "forecast": forecast,
            "gap": gap,
            "plan": plan_summary,
        }
        self.index = i + 1

    # ----------------------------------------------------------------- forecast

    def _forecast(self, origin: int, offset: float) -> dict[int, dict]:
        world = self.world
        demand = self.forecaster.predict(self.baseline_demand, origin, world.calendar, offset)
        pv_by_phase = {phase: sum(house.pv_kw for house in world.houses if house.phase == phase) for phase in PHASES}
        result = {}
        for horizon, phase_demand in demand.items():
            target = origin + horizon
            hour = float(world.hour[target])
            solar_factor = float(world.weather.solar_factor[target]) * (
                1 + float(world.weather.solar_forecast_error[origin, horizon - 1])
            )
            solar = {phase: max(pv_by_phase[phase] * solar_factor, 0.0) for phase in PHASES}
            baseline_phase = {
                phase: float(expected_transformer_kw(phase_demand[phase] - solar[phase], hour)) for phase in PHASES
            }
            adjusted_phase = {
                phase: baseline_phase[phase] + self.planned_delta[phase].get(target, 0.0) for phase in PHASES
            }
            sigma = self.forecaster.residual_std[horizon]
            adjusted_total = sum(adjusted_phase.values())
            result[horizon] = {
                "target": target,
                "demand_kw": sum(phase_demand.values()),
                "solar_kw": sum(solar.values()),
                "baseline_phase": baseline_phase,
                "adjusted_phase": adjusted_phase,
                "baseline_total": sum(baseline_phase.values()),
                "adjusted_total": adjusted_total,
                "lower": adjusted_total - FORECAST_BAND_Z * sigma,
                "upper": adjusted_total + FORECAST_BAND_Z * sigma,
                "temperature_c": float(world.weather.temperature_c[target])
                + float(world.weather.temperature_forecast_error[origin, horizon - 1])
                + offset,
            }
        return result

    # ----------------------------------------------------------- time shifting

    def _plan_time_shift(self, i: int, gap, forecast: dict) -> dict:
        add_total, add_phase = self._planned_add()
        plan = plan_time_shift(
            now_index=i,
            gap=gap,
            events=list(self.events.values()),
            houses=self.houses,
            profile_total=self._profile_total,
            profile_phase=self._profile_phase,
            planned_add_total=add_total,
            planned_add_phase=add_phase,
            limit_kw=self.config["safe_limit_kw"],
            phase_limit_kw=self.config["phase_limit_kw"],
            valley_fraction=VALLEY_TARGET_FRACTION,
            safety_margin=SHIFT_SAFETY_MARGIN,
        )
        summary = {
            "need_total_kw": gap.total_gap_kw,
            "need_phase_kw": gap.phase_gap_kw,
            "requested_kw": 0.0,
            "expected_kw": 0.0,
            "residual_kw": max(gap.total_gap_kw, max(gap.phase_gap_kw.values())),
        }
        if plan is None:
            return summary

        if plan.selected:
            action = self._create_shift_action(i, plan, forecast)
            if self.config["auto_dispatch"]:
                self._dispatch_shift(action, i)
            summary["requested_kw"] = round(sum(c.relief_kw for c in plan.selected), 3)
        summary["expected_kw"] = plan.expected_total_kw
        summary["residual_kw"] = plan.residual_kw
        if plan.residual_kw > 0.1:
            self._escalate_residual(i, plan, forecast)
        return summary

    def _create_shift_action(self, i: int, plan: ShiftPlan, forecast: dict) -> dict:
        requests = []
        for candidate in plan.selected:
            event = candidate.event
            current_draw = event.projected_draw(i + 1)
            requests.append(
                {
                    "event_id": event.event_id,
                    "house_id": event.house_id,
                    "phase": candidate.house.phase,
                    "appliance": event.label,
                    "load_class": event.load_class,
                    "power_kw": event.power_kw,
                    "relief_kw": candidate.relief_kw,
                    "accept_prob": candidate.house.accept_prob,
                    "original_start": self._time(min(current_draw) if current_draw else i + 1),
                    "new_start": self._time(candidate.new_start),
                    "new_start_index": candidate.new_start,
                    "deadline": self._time(event.deadline),
                    "message": f"Please run your {event.label.lower()} after {self.world.timestamp(candidate.new_start):%H:%M} "
                    f"instead of now. It will still finish before {self.world.timestamp(event.deadline):%H:%M}.",
                    "response": "pending",
                }
            )
        baseline_by_index = {forecast[h]["target"]: forecast[h]["baseline_total"] for h in forecast}
        action = {
            "id": self._new_id("TS"),
            "type": "time_shift",
            "status": "pending_approval",
            "created_at": self._time(i),
            "created_index": i,
            "window_start": self._time(plan.window_start),
            "window_end": self._time(plan.window_end + 1),
            "window_start_index": plan.window_start,
            "window_end_index": plan.window_end,
            "need_kw": plan.need_total_kw,
            "need_phase_kw": plan.need_phase_kw,
            "expected_kw": plan.expected_total_kw,
            "committed_kw": 0.0,
            "residual_kw": plan.residual_kw,
            "requests": requests,
            "baseline_by_index": baseline_by_index,
            "verification": None,
            "summary": f"Ask {len(requests)} household(s) to move {sum(r['relief_kw'] for r in requests):.1f} kW out of "
            f"{self.world.timestamp(plan.window_start):%H:%M}-{self.world.timestamp(plan.window_end + 1):%H:%M}",
        }
        for request in requests:
            self.events[request["event_id"]].requested = True
        self.actions.insert(0, action)
        return action

    def _dispatch_shift(self, action: dict, i: int):
        action["status"] = "dispatched"
        action["dispatched_at"] = self._time(i)
        committed = 0.0
        for request in action["requests"]:
            event = self.events.get(request["event_id"])
            house = self.houses[request["house_id"]]
            self.totals["requests_sent"] += 1
            if event is None or event.status == "done":
                request["response"] = "expired"
                continue
            if self.rng.random() >= house.accept_prob:
                request["response"] = "declined"
                self.totals["requests_declined"] += 1
                continue
            before = event.projected_draw(i + 1)
            if event.event_id not in self.baseline_profiles:
                self.baseline_profiles[event.event_id] = dict(before)
            if event.status == "running":
                event.paused_until = request["new_start_index"]
            else:
                event.scheduled_start = request["new_start_index"]
            event.shifted = True
            after = event.projected_draw(i + 1)
            for index in set(before) | set(after):
                delta = after.get(index, 0.0) - before.get(index, 0.0)
                if abs(delta) > 1e-9:
                    self.planned_delta[house.phase][index] = self.planned_delta[house.phase].get(index, 0.0) + delta
            request["response"] = "accepted"
            committed += request["relief_kw"]
            self.totals["requests_accepted"] += 1
            self.totals["energy_shifted_kwh"] = round(
                self.totals["energy_shifted_kwh"] + sum(before.values()) * INTERVAL_MINUTES / 60, 3
            )
        action["committed_kw"] = round(committed, 3)

    def _expire_pending(self, i: int):
        for action in self.actions:
            if action["type"] == "time_shift" and action["status"] == "pending_approval":
                if i - action["created_index"] >= PENDING_ACTION_EXPIRY_INTERVALS:
                    action["status"] = "expired"
                    for request in action["requests"]:
                        event = self.events.get(request["event_id"])
                        if event is not None and not event.shifted:
                            event.requested = False

    def _escalate_residual(self, i: int, plan: ShiftPlan, forecast: dict):
        for escalation in self.escalations:
            if escalation["status"] == "open" and escalation["window_end_index"] >= plan.window_start:
                escalation["residual_kw"] = max(escalation["residual_kw"], plan.residual_kw)
                escalation["window_end_index"] = max(escalation["window_end_index"], plan.window_end)
                escalation["window_end"] = self._time(escalation["window_end_index"] + 1)
                return
        where = f"phase {plan.residual_phase}" if plan.residual_phase else "the transformer"
        self.escalations.insert(
            0,
            {
                "id": self._new_id("ESC"),
                "status": "open",
                "created_at": self._time(i),
                "window_start": self._time(plan.window_start),
                "window_end": self._time(plan.window_end + 1),
                "window_end_index": plan.window_end,
                "residual_kw": plan.residual_kw,
                "where": where,
                "reason": f"Local flexibility cannot close the forecast gap on {where}: "
                f"{plan.candidates_considered} eligible appliance(s) found, {plan.infeasible} had no safe slot before their deadline.",
                "recommendation": "DISCOM to check authorized network options (feeder reconfiguration, load transfer via tie point) for this window.",
            },
        )
        self.totals["escalations"] += 1

    # ------------------------------------------------------------ phase balance

    def _house_peak_window_kw(self, end_index: int) -> dict[str, float]:
        start_hour, end_hour = PEAK_WINDOW_HOURS
        indices = np.arange(max(end_index - WEEK, 0), end_index)
        hours = self.world.hour[indices]
        mask = (hours >= start_hour) & (hours < end_hour)
        selected = indices[mask]
        return {
            house.house_id: float(self.world.house_net[row, selected].mean()) if len(selected) else 0.0
            for row, house in enumerate(self.world.houses)
        }

    def _consider_phase_rebalance(self, i: int, gap):
        open_phase = any(
            action["type"] == "phase_rebalance" and action["status"] in ("pending_approval", "crew_scheduled")
            for action in self.actions
        )
        if open_phase or i - self.last_phase_action_index < PHASE_ACTION_COOLDOWN_INTERVALS:
            return
        house_peak = self._house_peak_window_kw(i + 1)
        recommendation = plan_phase_rebalance(self.world.houses, house_peak)
        if recommendation is None:
            return
        phase_gap = max(gap.phase_gap_kw.values()) if gap else 0.0
        if recommendation["imbalance_before_pct"] < PHASE_IMBALANCE_TRIGGER_PCT and phase_gap <= 0:
            return
        moves = recommendation["moves"]
        self.actions.insert(
            0,
            {
                "id": self._new_id("PH"),
                "type": "phase_rebalance",
                "status": "pending_approval",
                "created_at": self._time(i),
                "created_index": i,
                **recommendation,
                "summary": "Move "
                + ", ".join(f"{move['house_id']} {move['from_phase']}→{move['to_phase']}" for move in moves)
                + f" to cut evening phase imbalance from {recommendation['imbalance_before_pct']:.0f}% "
                f"to {recommendation['imbalance_after_pct']:.0f}%",
                "note": "Planning action. A utility field crew changes the service connections during a short planned "
                "interruption; medical households are never moved.",
                "verification": None,
            },
        )
        self.last_phase_action_index = i

    def _execute_phase_changes(self, i: int):
        for action in self.actions:
            if action["type"] != "phase_rebalance" or action["status"] != "crew_scheduled":
                continue
            if i < action["execute_index"]:
                continue
            for move in action["moves"]:
                self.houses[move["house_id"]].phase = move["to_phase"]
            self.world.rebuild_phase_series(i + 1)
            for phase in PHASES:
                self.baseline_demand[phase][: i + 1] = (
                    self.world.phase_demand[phase][: i + 1]
                    + self.house_shift_diff[self._phase_members(phase), : i + 1].sum(axis=0)
                )
            self.forecaster.refit(self.baseline_demand, i + 1, self.world.calendar)
            self.planned_delta = self._rebuild_planned_delta(i)
            action["status"] = "executed"
            action["executed_at"] = self._time(i)
            action["executed_index"] = i
            action["verification"] = {"status": "measuring", "peak_intervals_observed": 0}

    def _rebuild_planned_delta(self, i: int) -> dict[str, dict[int, float]]:
        delta: dict[str, dict[int, float]] = {phase: {} for phase in PHASES}
        for event_id, baseline in self.baseline_profiles.items():
            event = self.events.get(event_id)
            if event is None:
                continue
            phase = self.houses[event.house_id].phase
            current = event.projected_draw(i + 1)
            for index in set(baseline) | set(current):
                if index <= i:
                    continue
                value = current.get(index, 0.0) - baseline.get(index, 0.0)
                if abs(value) > 1e-9:
                    delta[phase][index] = delta[phase].get(index, 0.0) + value
        return delta

    # ------------------------------------------------------------ verification

    def _verify_actions(self, i: int):
        limit = self.config["safe_limit_kw"]
        phase_limit = self.config["phase_limit_kw"]
        for action in self.actions:
            if action["type"] == "time_shift" and action["status"] in ("dispatched", "verifying"):
                start, end = action["window_start_index"], action["window_end_index"]
                if i < start:
                    continue
                observed = [index for index in range(start, min(i, end) + 1)]
                delivered = []
                measured = []
                for index in observed:
                    relief = 0.0
                    for request in action["requests"]:
                        if request["response"] != "accepted":
                            continue
                        event = self.events.get(request["event_id"])
                        baseline = self.baseline_profiles.get(request["event_id"], {})
                        actual = event.history.get(index, 0.0) if event else 0.0
                        relief += baseline.get(index, 0.0) - actual
                    delivered.append(relief)
                    if index in action["baseline_by_index"]:
                        measured.append(action["baseline_by_index"][index] - float(self.world.transformer_total[index]))
                peak_total = max(float(self.world.transformer_total[index]) for index in observed)
                peak_phase = {
                    phase: max(float(self.world.transformer_phase[phase][index]) for index in observed) for phase in PHASES
                }
                within = peak_total <= limit and all(value <= phase_limit for value in peak_phase.values())
                finished = i >= end
                action["status"] = "verified" if finished else "verifying"
                action["verification"] = {
                    "status": ("resolved" if within else "limit_exceeded") if finished else "in_progress",
                    "planned_kw": action["expected_kw"],
                    "committed_kw": action["committed_kw"],
                    "delivered_kw": round(float(np.mean(delivered)), 3) if delivered else 0.0,
                    "measured_kw": round(float(np.mean(measured)), 3) if measured else None,
                    "peak_total_kw": round(peak_total, 2),
                    "peak_phase_kw": {phase: round(value, 2) for phase, value in peak_phase.items()},
                    "intervals_observed": len(observed),
                }
            elif action["type"] == "phase_rebalance" and action["status"] == "executed":
                hour = float(self.world.hour[i])
                start_hour, end_hour = PEAK_WINDOW_HOURS
                if not (start_hour <= hour < end_hour) or i <= action["executed_index"]:
                    continue
                verification = action["verification"]
                verification["peak_intervals_observed"] += 1
                sums = verification.setdefault("phase_sum_kw", {phase: 0.0 for phase in PHASES})
                for phase in PHASES:
                    sums[phase] += float(self.world.transformer_phase[phase][i])
                count = verification["peak_intervals_observed"]
                measured = {phase: sums[phase] / count for phase in PHASES}
                verification["measured_phase_kw"] = {phase: round(value, 2) for phase, value in measured.items()}
                verification["measured_imbalance_pct"] = imbalance_pct(measured)
                if count >= 8:
                    verification["status"] = (
                        "improved"
                        if verification["measured_imbalance_pct"] < action["imbalance_before_pct"]
                        else "not_improved"
                    )
                    action["status"] = "verified"

    # ---------------------------------------------------------------- commands

    def approve(self, action_id: str) -> Optional[dict]:
        action = self._find_action(action_id)
        if action is None or action["status"] != "pending_approval":
            return None
        current_index = self.index - 1
        if action["type"] == "time_shift":
            self._dispatch_shift(action, current_index)
        else:
            action["status"] = "crew_scheduled"
            action["approved_at"] = self._time(current_index)
            action["execute_index"] = current_index + PHASE_CREW_DELAY_INTERVALS
            action["execute_at"] = self._time(action["execute_index"])
        return action

    def reject(self, action_id: str) -> Optional[dict]:
        action = self._find_action(action_id)
        if action is None or action["status"] != "pending_approval":
            return None
        action["status"] = "rejected"
        if action["type"] == "time_shift":
            for request in action["requests"]:
                event = self.events.get(request["event_id"])
                if event is not None:
                    event.requested = False
        else:
            self.last_phase_action_index = self.index - 1
        return action

    def acknowledge(self, escalation_id: str) -> Optional[dict]:
        for escalation in self.escalations:
            if escalation["id"] == escalation_id and escalation["status"] == "open":
                escalation["status"] = "acknowledged"
                return escalation
        return None

    def update_config(self, values: dict):
        for key, value in values.items():
            if value is not None and key in self.config:
                self.config[key] = value

    def _find_action(self, action_id: str) -> Optional[dict]:
        return next((action for action in self.actions if action["id"] == action_id), None)

    # ---------------------------------------------------------------- snapshot

    def snapshot(self) -> dict:
        current = self.current
        i = current["index"]
        world = self.world
        limit = self.config["safe_limit_kw"]
        phase_limit = self.config["phase_limit_kw"]
        transformer = current["transformer"]
        total = current["total_kw"]
        gap = current["gap"]
        start_hour, end_hour = PEAK_WINDOW_HOURS

        def status(value: float, value_limit: float) -> str:
            if value > value_limit:
                return "overloaded"
            if value >= 0.9 * value_limit:
                return "near_limit"
            return "normal"

        phases = []
        for phase in PHASES:
            data = transformer[phase]
            phases.append(
                {
                    "phase": phase,
                    "kw": _round(data["kw"]),
                    "limit_kw": phase_limit,
                    "loading_pct": _round(data["kw"] / phase_limit * 100, 1),
                    "voltage_v": data["voltage_v"],
                    "current_a": data["current_a"],
                    "power_factor": data["power_factor"],
                    "status": status(data["kw"], phase_limit),
                    "houses": [house.house_id for house in world.houses if house.phase == phase],
                }
            )
        phase_kw = {phase: transformer[phase]["kw"] for phase in PHASES}
        apparent_kva = sum(transformer[phase]["kw"] / transformer[phase]["power_factor"] for phase in PHASES)

        forecast = current["forecast"]
        horizons = []
        for horizon, data in forecast.items():
            gap_total = max(data["adjusted_total"] - limit, 0.0)
            horizons.append(
                {
                    "minutes": horizon * INTERVAL_MINUTES,
                    "time": self._time(data["target"]),
                    "demand_kw": _round(data["demand_kw"]),
                    "solar_kw": _round(data["solar_kw"]),
                    "net_kw": _round(data["baseline_total"]),
                    "adjusted_kw": _round(data["adjusted_total"]),
                    "lower_kw": _round(data["lower"]),
                    "upper_kw": _round(data["upper"]),
                    "phases": {phase: _round(value) for phase, value in data["adjusted_phase"].items()},
                    "gap_kw": _round(gap_total),
                    "phase_gap_kw": {
                        phase: _round(max(value - phase_limit, 0.0)) for phase, value in data["adjusted_phase"].items()
                    },
                    "temperature_c": _round(data["temperature_c"], 1),
                }
            )

        eligible_kw = 0.0
        for event in self.events.values():
            house = self.houses[event.house_id]
            if (
                event.status != "done"
                and event.load_class in SHIFTABLE_CLASSES
                and house.enrolled
                and not house.medical
                and not event.requested
                and (event.status != "running" or event.interruptible)
            ):
                draws = event.projected_draw(i + 1)
                eligible_kw += max((draws.get(i + h, 0.0) for h in range(1, FORECAST_HORIZON_STEPS + 1)), default=0.0)

        plan = current["plan"]
        worst = gap.worst_horizon
        gap_section = {
            "status": "gap" if gap.any_gap else "clear",
            "total_gap_kw": gap.total_gap_kw,
            "phase_gap_kw": gap.phase_gap_kw,
            "worst_minutes": worst * INTERVAL_MINUTES if worst else None,
            "worst_time": self._time(i + worst) if worst else None,
            "time_shift_requested_kw": plan["requested_kw"] if plan else 0.0,
            "time_shift_expected_kw": plan["expected_kw"] if plan else 0.0,
            "residual_kw": plan["residual_kw"] if plan else 0.0,
        }

        house_peak = self._house_peak_window_kw(i + 1)
        peak_phase = {phase: 0.0 for phase in PHASES}
        for house in world.houses:
            peak_phase[house.phase] += house_peak[house.house_id]

        gateway = current["gateway"]
        meters = []
        for row, reading in enumerate(gateway.readings):
            house = self.houses[reading.house_id]
            meters.append(
                {
                    "house_id": house.house_id,
                    "label": house.label,
                    "phase": house.phase,
                    "consumption_kw": _round(reading.consumption_kw),
                    "generation_kw": _round(reading.generation_kw),
                    "net_kw": _round(reading.net_kw),
                    "flag": reading.flag,
                    "enrolled": house.enrolled,
                    "medical": house.medical,
                    "accept_prob": house.accept_prob,
                    "pv_kw": house.pv_kw,
                    "running": current["running_by_house"].get(house.house_id, []),
                    "shifted": any(
                        event.shifted and event.status != "done" and event.house_id == house.house_id
                        for event in self.events.values()
                    ),
                }
            )

        demand_total = sum(current["consumption"].values())
        solar_total = sum(current["generation"].values())
        timestamp = world.timestamp(i)
        return {
            "clock": {
                "time": self._time(i),
                "interval_end": self._time(i + 1),
                "weekday": f"{timestamp:%A}",
                "running": self.running,
                "seconds_per_interval": self.seconds_per_interval,
                "in_peak_window": start_hour <= current["hour"] < end_hour,
                "interval_minutes": INTERVAL_MINUTES,
            },
            "config": {
                **self.config,
                "transformer_rating_kva": TRANSFORMER_RATING_KVA,
                "horizon_minutes": FORECAST_HORIZON_STEPS * INTERVAL_MINUTES,
            },
            "weather": {
                "temperature_c": _round(current["temperature"], 1),
                "cloud_pct": _round(float(world.weather.cloud[i]) * 100, 0),
                "solar_factor": _round(float(world.weather.solar_factor[i]), 2),
            },
            "transformer": {
                "total_kw": _round(total),
                "loading_pct": _round(total / limit * 100, 1),
                "apparent_kva": _round(apparent_kva),
                "rating_pct": _round(apparent_kva / TRANSFORMER_RATING_KVA * 100, 1),
                "status": "overloaded"
                if total > limit or any(value > phase_limit for value in phase_kw.values())
                else ("near_limit" if total >= 0.9 * limit else "normal"),
                "phases": phases,
                "imbalance_pct": imbalance_pct(phase_kw),
                "consistency": current["consistency"],
            },
            "demand": {
                "gross_kw": _round(demand_total),
                "solar_kw": _round(solar_total),
                "net_kw": _round(demand_total - solar_total),
                "avg_per_house_kw": _round(demand_total / len(world.houses)),
                "by_class": {key: _round(value) for key, value in current["by_class"].items()},
                "eligible_shiftable_kw": _round(eligible_kw),
            },
            "quality": {
                "meters": len(gateway.readings),
                "counts": gateway.counts,
                "score_pct": _round(gateway.counts["ok"] / len(gateway.readings) * 100, 1),
                "issues": gateway.issues,
            },
            "forecast": {
                "horizons": horizons,
                "model": {
                    "type": "Ridge regression per phase and horizon",
                    "features": list(FEATURE_NAMES),
                    "training_days": round(self.forecaster.training_intervals / INTERVALS_PER_DAY),
                    "holdout": {
                        str(h * INTERVAL_MINUTES): metrics for h, metrics in self.forecaster.holdout_metrics.items()
                    },
                    "live_mae_15_kw": _round(float(np.mean(self.live_errors)), 2) if self.live_errors else None,
                    "data_note": "Trained and scored on one year of synthetic data",
                },
            },
            "gap": gap_section,
            "phase_balance": {
                "imbalance_now_pct": imbalance_pct(phase_kw),
                "peak_window_kw": {phase: _round(value) for phase, value in peak_phase.items()},
                "peak_window_imbalance_pct": imbalance_pct(peak_phase),
            },
            "actions": [self._public_action(action) for action in self.actions[:25]],
            "escalations": self.escalations[:15],
            "meters": meters,
            "history": list(self.history),
            "totals": {
                **self.totals,
                "without_vs_with_note": "Without = same houses with every shifted appliance on its default schedule",
            },
        }

    @staticmethod
    def _public_action(action: dict) -> dict:
        return {key: value for key, value in action.items() if key not in ("baseline_by_index",)}
