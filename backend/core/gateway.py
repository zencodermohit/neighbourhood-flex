"""Local edge gateway: receive smart-meter readings, validate them, aggregate by phase.

Faults are injected into the raw readings the way field meters misbehave:
missing readings, spikes and stuck registers. The gateway repairs what it can
and flags every repair, so downstream forecasting only sees clean data.
"""

from dataclasses import dataclass, field

import numpy as np

from config import METER_MISSING_PROB, METER_SPIKE_PROB, METER_STUCK_PROB

MAX_PLAUSIBLE_KW = 15.0
MAX_PLAUSIBLE_STEP_KW = 6.0  # an EV or pump switching on is a step of 1-4 kW, not 6+
STUCK_REPEATS = 3


@dataclass(slots=True)
class MeterReading:
    house_id: str
    phase: str
    consumption_kw: float
    generation_kw: float
    flag: str  # ok, imputed_missing, rejected_spike, stuck

    @property
    def net_kw(self) -> float:
        return self.consumption_kw - self.generation_kw


@dataclass(slots=True)
class GatewayResult:
    readings: list[MeterReading]
    phase_consumption_kw: dict[str, float]
    phase_generation_kw: dict[str, float]
    counts: dict[str, int]
    issues: list[dict]


@dataclass
class EdgeGateway:
    rng: np.random.Generator
    last_valid: dict[str, float] = field(default_factory=dict)
    last_raw: dict[str, float] = field(default_factory=dict)
    repeat_count: dict[str, int] = field(default_factory=dict)
    stuck_until: dict[str, int] = field(default_factory=dict)
    issue_log: list[dict] = field(default_factory=list)

    def process(
        self,
        index: int,
        timestamp: str,
        houses: list,
        consumption_kw: dict[str, float],
        generation_kw: dict[str, float],
    ) -> GatewayResult:
        readings: list[MeterReading] = []
        counts = {"ok": 0, "imputed_missing": 0, "rejected_spike": 0, "stuck": 0}
        new_issues: list[dict] = []

        for house in houses:
            true_value = consumption_kw[house.house_id]
            raw: float | None = true_value
            roll = self.rng.random()
            if index < self.stuck_until.get(house.house_id, -1):
                raw = self.last_raw.get(house.house_id, true_value)
            elif roll < METER_MISSING_PROB:
                raw = None
            elif roll < METER_MISSING_PROB + METER_SPIKE_PROB:
                raw = true_value * 8 + 6
            elif roll < METER_MISSING_PROB + METER_SPIKE_PROB + METER_STUCK_PROB:
                # The register freezes for the next few readings.
                self.stuck_until[house.house_id] = index + int(self.rng.integers(3, 7))
                raw = self.last_raw.get(house.house_id, true_value)

            previous = self.last_valid.get(house.house_id, true_value)
            if raw is None:
                value, flag = previous, "imputed_missing"
            elif raw > MAX_PLAUSIBLE_KW or (raw - previous > MAX_PLAUSIBLE_STEP_KW and raw > 4 * max(previous, 0.5)):
                value, flag = previous, "rejected_spike"
            else:
                value, flag = raw, "ok"
                if self.last_raw.get(house.house_id) == raw:
                    self.repeat_count[house.house_id] = self.repeat_count.get(house.house_id, 0) + 1
                else:
                    self.repeat_count[house.house_id] = 0
                if self.repeat_count[house.house_id] >= STUCK_REPEATS - 1:
                    flag = "stuck"

            if raw is not None:
                self.last_raw[house.house_id] = raw
            if flag == "ok":
                self.last_valid[house.house_id] = value

            counts[flag] += 1
            if flag != "ok":
                new_issues.append(
                    {
                        "time": timestamp,
                        "house_id": house.house_id,
                        "issue": flag,
                        "detail": {
                            "imputed_missing": "No reading received; last valid value used",
                            "rejected_spike": f"Implausible {raw:.1f} kW rejected; last valid value used" if raw else "",
                            "stuck": "Identical register value repeated; reading kept but flagged",
                        }[flag],
                    }
                )

            readings.append(
                MeterReading(
                    house_id=house.house_id,
                    phase=house.phase,
                    consumption_kw=round(value, 4),
                    generation_kw=round(generation_kw[house.house_id], 4),
                    flag=flag,
                )
            )

        self.issue_log = (new_issues + self.issue_log)[:12]
        phase_consumption = {phase: 0.0 for phase in ("L1", "L2", "L3")}
        phase_generation = {phase: 0.0 for phase in ("L1", "L2", "L3")}
        for reading in readings:
            phase_consumption[reading.phase] += reading.consumption_kw
            phase_generation[reading.phase] += reading.generation_kw

        return GatewayResult(
            readings=readings,
            phase_consumption_kw=phase_consumption,
            phase_generation_kw=phase_generation,
            counts=counts,
            issues=self.issue_log,
        )
