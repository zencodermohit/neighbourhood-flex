"""Flexibility gap, load time-shifting and phase balancing.

Two network-level options close a forecast gap:

* Load time-shifting (operational, minutes ahead): ask enrolled households to
  move eligible flexible or deferrable load out of the constrained window to a
  slot where the transformer has room. Households may decline, so the planner
  asks for more than the gap and the response is verified afterwards.
* Phase rebalancing (planning, hours to days ahead): recommend moving
  single-phase connections from the overloaded phase to a lighter one. A
  utility field crew performs the physical change after approval.

Whatever local flexibility cannot cover is reported as residual risk for the
utility, never hidden.
"""

from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np

from core.households import PHASES, ApplianceEvent, House

SHIFTABLE_CLASSES = {"highly_deferrable": 0, "flexible": 1}


@dataclass(slots=True)
class GapAssessment:
    total_gap_kw: float
    phase_gap_kw: dict[str, float]
    worst_horizon: Optional[int]
    constrained_horizons: list[int]

    @property
    def any_gap(self) -> bool:
        return bool(self.constrained_horizons)


def assess_gap(
    forecast_by_horizon: dict[int, dict[str, float]],
    limit_kw: float,
    phase_limit_kw: float,
) -> GapAssessment:
    total_gap = 0.0
    phase_gap = {phase: 0.0 for phase in PHASES}
    constrained: list[int] = []
    worst_horizon = None
    worst_value = 0.0
    for horizon, phases in forecast_by_horizon.items():
        gap_total = max(sum(phases.values()) - limit_kw, 0.0)
        gaps = {phase: max(phases[phase] - phase_limit_kw, 0.0) for phase in PHASES}
        severity = max(gap_total, max(gaps.values()))
        if severity > 0.05:
            constrained.append(horizon)
            if severity > worst_value:
                worst_value = severity
                worst_horizon = horizon
        total_gap = max(total_gap, gap_total)
        for phase in PHASES:
            phase_gap[phase] = max(phase_gap[phase], gaps[phase])
    return GapAssessment(
        total_gap_kw=round(total_gap, 3),
        phase_gap_kw={phase: round(value, 3) for phase, value in phase_gap.items()},
        worst_horizon=worst_horizon,
        constrained_horizons=constrained,
    )


@dataclass(slots=True)
class ShiftCandidate:
    event: ApplianceEvent
    house: House
    relief_kw: float
    new_start: int


@dataclass
class ShiftPlan:
    window_start: int
    window_end: int
    need_total_kw: float
    need_phase_kw: dict[str, float]
    selected: list[ShiftCandidate]
    expected_total_kw: float
    expected_phase_kw: dict[str, float]
    residual_kw: float
    residual_phase: Optional[str]
    candidates_considered: int
    infeasible: int = 0
    notes: list[str] = field(default_factory=list)


def plan_time_shift(
    now_index: int,
    gap: GapAssessment,
    events: list[ApplianceEvent],
    houses: dict[str, House],
    profile_total: Callable[[int], float],
    profile_phase: Callable[[int, str], float],
    planned_add_total: dict[int, float],
    planned_add_phase: dict[str, dict[int, float]],
    limit_kw: float,
    phase_limit_kw: float,
    valley_fraction: float,
    safety_margin: float,
) -> Optional[ShiftPlan]:
    if not gap.any_gap:
        return None

    window = [now_index + horizon for horizon in gap.constrained_horizons]
    window_start, window_end = min(window), max(window)
    need_total = gap.total_gap_kw
    need_phase = dict(gap.phase_gap_kw)

    add_total = dict(planned_add_total)
    add_phase = {phase: dict(planned_add_phase.get(phase, {})) for phase in PHASES}

    def fits(start: int, length: int, power: float, phase: str) -> bool:
        for index in range(start, start + length):
            if profile_total(index) + add_total.get(index, 0.0) + power > valley_fraction * limit_kw:
                return False
            if profile_phase(index, phase) + add_phase[phase].get(index, 0.0) + power > valley_fraction * phase_limit_kw:
                return False
        return True

    candidates: list[ShiftCandidate] = []
    infeasible = 0
    for event in events:
        house = houses[event.house_id]
        if event.status == "done" or event.requested or event.load_class not in SHIFTABLE_CLASSES:
            continue
        if not house.enrolled or house.medical:
            continue
        if event.status == "running" and not event.interruptible:
            continue
        current = event.projected_draw(now_index + 1)
        relief = max((current.get(index, 0.0) for index in window), default=0.0)
        if relief <= 0.05:
            continue
        length = event.intervals_needed()
        new_start = None
        for start in range(window_end + 1, event.latest_start() + 1):
            if fits(start, length, event.power_kw, house.phase):
                new_start = start
                break
        if new_start is None:
            infeasible += 1
            continue
        candidates.append(ShiftCandidate(event=event, house=house, relief_kw=round(relief, 3), new_start=new_start))

    candidates.sort(
        key=lambda c: (SHIFTABLE_CLASSES[c.event.load_class], -c.relief_kw * c.house.accept_prob, c.event.event_id)
    )

    remaining_total = need_total * safety_margin
    remaining_phase = {phase: need_phase[phase] * safety_margin for phase in PHASES}
    selected: list[ShiftCandidate] = []
    expected_phase = {phase: 0.0 for phase in PHASES}
    for candidate in candidates:
        phase = candidate.house.phase
        if remaining_total <= 0 and remaining_phase[phase] <= 0:
            continue
        # Re-check the landing slot now that earlier selections have used some room.
        length = candidate.event.intervals_needed()
        if not fits(candidate.new_start, length, candidate.event.power_kw, phase):
            new_start = next(
                (
                    start
                    for start in range(candidate.new_start + 1, candidate.event.latest_start() + 1)
                    if fits(start, length, candidate.event.power_kw, phase)
                ),
                None,
            )
            if new_start is None:
                infeasible += 1
                continue
            candidate.new_start = new_start
        selected.append(candidate)
        expected = candidate.relief_kw * candidate.house.accept_prob
        remaining_total -= expected
        remaining_phase[phase] -= expected
        expected_phase[phase] += expected
        for index in range(candidate.new_start, candidate.new_start + length):
            add_total[index] = add_total.get(index, 0.0) + candidate.event.power_kw
            add_phase[phase][index] = add_phase[phase].get(index, 0.0) + candidate.event.power_kw
        if remaining_total <= 0 and all(value <= 0 for value in remaining_phase.values()):
            break

    expected_total = sum(expected_phase.values())
    residual_total = max(need_total - expected_total, 0.0)
    residual_by_phase = {phase: max(need_phase[phase] - expected_phase[phase], 0.0) for phase in PHASES}
    worst_phase = max(residual_by_phase, key=residual_by_phase.get)
    residual = max(residual_total, residual_by_phase[worst_phase])
    return ShiftPlan(
        window_start=window_start,
        window_end=window_end,
        need_total_kw=round(need_total, 3),
        need_phase_kw={phase: round(value, 3) for phase, value in need_phase.items()},
        selected=selected,
        expected_total_kw=round(expected_total, 3),
        expected_phase_kw={phase: round(value, 3) for phase, value in expected_phase.items()},
        residual_kw=round(residual, 3),
        residual_phase=worst_phase if residual_by_phase[worst_phase] > residual_total else None,
        candidates_considered=len(candidates),
        infeasible=infeasible,
    )


def imbalance_pct(phase_kw: dict[str, float]) -> float:
    values = [phase_kw[phase] for phase in PHASES]
    mean = sum(values) / len(values)
    return round((max(values) - mean) / mean * 100, 1) if mean > 0 else 0.0


def plan_phase_rebalance(
    houses: list[House],
    house_peak_kw: dict[str, float],
    max_moves: int = 3,
    min_improvement_kw: float = 0.3,
) -> Optional[dict]:
    """Greedy reassignment of single-phase connections to flatten peak-window phase loading.

    house_peak_kw is each house's average demand during the evening peak window
    over the last week. Medical households are never moved, because a phase
    change needs a short planned interruption.
    """
    assignment = {house.house_id: house.phase for house in houses}
    loads = {phase: 0.0 for phase in PHASES}
    for house in houses:
        loads[house.phase] += house_peak_kw[house.house_id]
    before = dict(loads)
    moves = []

    for _ in range(max_moves):
        heaviest = max(loads, key=loads.get)
        lightest = min(loads, key=loads.get)
        best = None
        for house in houses:
            if assignment[house.house_id] != heaviest or house.medical:
                continue
            kw = house_peak_kw[house.house_id]
            trial = dict(loads)
            trial[heaviest] -= kw
            trial[lightest] += kw
            new_max = max(trial.values())
            if best is None or new_max < best[0]:
                best = (new_max, house, kw, trial)
        if best is None or max(loads.values()) - best[0] < min_improvement_kw:
            break
        _, house, kw, trial = best
        assignment[house.house_id] = lightest
        loads = trial
        moves.append(
            {
                "house_id": house.house_id,
                "label": house.label,
                "from_phase": heaviest,
                "to_phase": lightest,
                "peak_window_kw": round(kw, 2),
            }
        )

    if not moves:
        return None
    return {
        "moves": moves,
        "phase_peak_before_kw": {phase: round(value, 2) for phase, value in before.items()},
        "phase_peak_after_kw": {phase: round(value, 2) for phase, value in loads.items()},
        "imbalance_before_pct": imbalance_pct(before),
        "imbalance_after_pct": imbalance_pct(loads),
    }


def peak_window_average(values: np.ndarray, hours: np.ndarray, start_hour: int, end_hour: int) -> float:
    mask = (hours >= start_hour) & (hours < end_hour)
    return float(values[mask].mean()) if mask.any() else 0.0
