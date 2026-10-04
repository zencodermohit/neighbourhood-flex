"""The 20 houses behind one distribution transformer, and what their smart meters see.

Each house's demand is split by protection class:
  critical           fridge, lighting, medical equipment: never shifted
  essential          cooking, fans, AC, TV: not shifted by default
  flexible           water pump, washing machine, geyser: can move within a window
  highly_deferrable  EV charging: can be paused and resumed before a deadline

Critical and essential load is a smooth daily profile driven by occupancy and
temperature. Flexible and deferrable load comes from discrete appliance events
with a default start time, an energy need and a deadline.
"""

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from config import INTERVAL_MINUTES, INTERVALS_PER_DAY

HOURS_PER_INTERVAL = INTERVAL_MINUTES / 60
LOAD_CLASSES = ("critical", "essential", "flexible", "highly_deferrable")
PHASES = ("L1", "L2", "L3")


@dataclass(slots=True)
class House:
    house_id: str
    number: int
    label: str
    archetype: str
    phase: str
    scale: float
    ac_kw: float
    pv_kw: float
    medical: bool
    enrolled: bool
    accept_prob: float
    appliances: tuple[str, ...]


# (label, archetype, phase, scale, ac_kw, pv_kw, medical, enrolled, accept_prob, appliances)
_HOUSE_TABLE = [
    ("3BHK family", "large", "L1", 1.4, 2.6, 3.0, False, True, 0.80, ("ev", "pump", "washer", "geyser")),
    ("2BHK family", "family", "L1", 1.0, 1.5, 0.0, False, True, 0.70, ("pump", "washer", "geyser")),
    ("2BHK family, rooftop PV", "family", "L1", 1.0, 1.5, 2.0, False, True, 0.75, ("ev", "pump", "washer")),
    ("Elderly couple, oxygen concentrator", "elderly", "L1", 0.7, 1.0, 0.0, True, False, 0.0, ("geyser",)),
    ("3BHK family", "large", "L1", 1.3, 2.4, 0.0, False, True, 0.60, ("pump", "washer", "geyser")),
    ("Home tailoring business", "business", "L2", 1.1, 1.0, 0.0, False, True, 0.50, ("pump", "washer")),
    ("2BHK family", "family", "L1", 1.0, 1.5, 0.0, False, True, 0.85, ("ev", "washer", "geyser")),
    ("1BHK flat", "flat", "L1", 0.6, 0.9, 0.0, False, False, 0.0, ("washer",)),
    ("2BHK family, rooftop PV", "family", "L2", 1.0, 1.5, 2.5, False, True, 0.70, ("pump", "washer", "geyser")),
    ("1BHK flat", "flat", "L2", 0.6, 0.0, 0.0, False, True, 0.60, ("washer",)),
    ("3BHK family, rooftop PV", "large", "L2", 1.3, 2.4, 3.0, False, True, 0.75, ("ev", "pump", "washer", "geyser")),
    ("2BHK family", "family", "L2", 0.9, 1.5, 0.0, False, True, 0.65, ("pump", "washer")),
    ("Elderly couple", "elderly", "L2", 0.7, 1.0, 0.0, False, False, 0.0, ("geyser",)),
    ("1BHK flat", "flat", "L2", 0.6, 0.9, 0.0, False, True, 0.80, ("washer",)),
    ("2BHK family", "family", "L3", 1.0, 1.5, 0.0, False, True, 0.70, ("pump", "washer", "geyser")),
    ("1BHK flat", "flat", "L3", 0.6, 0.0, 0.0, False, True, 0.60, ("washer",)),
    ("2BHK family, rooftop PV", "family", "L3", 0.9, 1.5, 2.0, False, True, 0.75, ("ev", "pump", "washer")),
    ("Kirana shop with home", "business", "L3", 1.1, 1.0, 0.0, False, True, 0.50, ("pump",)),
    ("1BHK flat", "flat", "L3", 0.6, 0.9, 0.0, False, True, 0.70, ("washer",)),
    ("2BHK family", "family", "L3", 1.0, 1.5, 0.0, False, True, 0.80, ("pump", "washer", "geyser")),
]


def build_houses() -> list[House]:
    return [
        House(
            house_id=f"H{index + 1}",
            number=index + 1,
            label=label,
            archetype=archetype,
            phase=phase,
            scale=scale,
            ac_kw=ac_kw,
            pv_kw=pv_kw,
            medical=medical,
            enrolled=enrolled,
            accept_prob=accept_prob,
            appliances=appliances,
        )
        for index, (label, archetype, phase, scale, ac_kw, pv_kw, medical, enrolled, accept_prob, appliances) in enumerate(
            _HOUSE_TABLE
        )
    ]


def _bump(hour: np.ndarray, center: float, width: float) -> np.ndarray:
    return np.exp(-(((hour - center) / width) ** 2))


def _between(hour: np.ndarray, start: float, end: float) -> np.ndarray:
    if start <= end:
        return ((hour >= start) & (hour < end)).astype(float)
    return ((hour >= start) | (hour < end)).astype(float)


def base_components(
    house: House,
    hour: np.ndarray,
    weekend: np.ndarray,
    temperature_c: np.ndarray,
    noise: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Critical and essential demand (kW) for one house over the given intervals."""
    scale = house.scale
    critical = (
        0.12
        + 0.15 * scale * _between(hour, 18.5, 23.5)
        + 0.05 * _between(hour, 23.5, 6.0)
        + 0.03 * _between(hour, 6.0, 18.5)
    )
    if house.medical:
        critical = critical + 0.25

    essential = (
        0.35 * scale * _bump(hour, 8.0, 0.8)
        + 0.20 * scale * _bump(hour, 13.0, 0.7)
        + 0.45 * scale * _bump(hour, 20.0, 0.9)
        + 0.15 * scale * _between(hour, 7.0, 23.0)
        + 0.25 * scale * _bump(hour, 21.0, 1.5)
        + 0.12 * scale * np.clip((temperature_c - 24.0) / 8.0, 0.0, 1.0)
    )
    if house.archetype == "business":
        essential = essential + 0.6 * _between(hour, 10.0, 19.0) * (1 - 0.5 * weekend)

    if house.ac_kw > 0:
        # Average compressor duty: rises with temperature, never runs flat out on average.
        duty = 0.6 * np.clip((temperature_c - 27.0) / 8.0, 0.0, 1.0)
        afternoon = np.where(weekend, 0.7, 0.35 if house.archetype in ("family", "large") else 0.6)
        occupancy = (
            0.9 * _between(hour, 21.0, 6.0)
            + afternoon * _between(hour, 13.0, 17.0)
            + 0.6 * _between(hour, 17.0, 21.0)
            + 0.1 * _between(hour, 6.0, 13.0)
        )
        essential = essential + house.ac_kw * duty * occupancy

    return critical * noise, essential * noise


@dataclass(slots=True)
class ApplianceEvent:
    event_id: str
    house_id: str
    kind: str
    load_class: str
    label: str
    power_kw: float
    energy_kwh: float
    default_start: int
    deadline: int  # interval index by which the energy must be delivered
    interruptible: bool
    scheduled_start: int = 0
    delivered_kwh: float = 0.0
    paused_until: Optional[int] = None
    status: str = "waiting"  # waiting, running, done
    requested: bool = False
    shifted: bool = False
    history: dict[int, float] = field(default_factory=dict)  # actual draw per interval

    @property
    def remaining_kwh(self) -> float:
        return max(self.energy_kwh - self.delivered_kwh, 0.0)

    def intervals_needed(self, remaining: Optional[float] = None) -> int:
        energy = self.remaining_kwh if remaining is None else remaining
        return int(np.ceil(energy / (self.power_kw * HOURS_PER_INTERVAL) - 1e-9))

    def latest_start(self) -> int:
        return self.deadline - self.intervals_needed()

    def draw(self, index: int) -> float:
        """Advance the appliance through one interval and return its average draw (kW)."""
        if self.status == "done":
            return 0.0
        must_run = index >= self.latest_start()
        if self.paused_until is not None and index < self.paused_until and not must_run:
            return 0.0
        if self.status == "waiting" and index < self.scheduled_start and not must_run:
            return 0.0
        self.status = "running"
        self.paused_until = None
        kw = min(self.power_kw, self.remaining_kwh / HOURS_PER_INTERVAL)
        self.delivered_kwh += kw * HOURS_PER_INTERVAL
        self.history[index] = kw
        if self.remaining_kwh <= 1e-6:
            self.status = "done"
        return kw

    def projected_draw(self, from_index: int, start_index: Optional[int] = None) -> dict[int, float]:
        """Draw per interval from from_index onward.

        Without start_index this is the current plan: keep running if running,
        resume after a pause, or start at the scheduled time. Either way the
        appliance starts no later than it must to meet its deadline.
        """
        if self.status == "done":
            return {}
        if start_index is not None:
            start = start_index
        elif self.paused_until is not None:
            start = self.paused_until
        elif self.status == "running":
            start = from_index
        else:
            start = self.scheduled_start
        start = max(from_index, min(start, self.latest_start()))
        remaining = self.remaining_kwh
        profile: dict[int, float] = {}
        index = start
        while remaining > 1e-6:
            kw = min(self.power_kw, remaining / HOURS_PER_INTERVAL)
            profile[index] = kw
            remaining -= kw * HOURS_PER_INTERVAL
            index += 1
        return profile


_APPLIANCE_LABELS = {
    "ev": "EV charger",
    "pump": "Water pump",
    "washer": "Washing machine",
    "geyser": "Water heater",
}


def _time_index(day: int, hour: float) -> int:
    return day * INTERVALS_PER_DAY + int(round(hour * INTERVALS_PER_DAY / 24))


def generate_events(house: House, day: int, weekend: bool, morning_temp_c: float, seed: int) -> list[ApplianceEvent]:
    """Appliance events for one house on one day, identical every time they are generated."""
    rng = np.random.default_rng([seed, house.number, day])
    events: list[ApplianceEvent] = []

    def add(kind: str, load_class: str, power: float, energy: float, start_hour: float, deadline_index: int, interruptible: bool):
        start = _time_index(day, start_hour)
        events.append(
            ApplianceEvent(
                event_id=f"{house.house_id}-{kind}-{day}",
                house_id=house.house_id,
                kind=kind,
                load_class=load_class,
                label=_APPLIANCE_LABELS[kind],
                power_kw=power,
                energy_kwh=round(energy, 3),
                default_start=start,
                deadline=max(deadline_index, start + int(np.ceil(energy / (power * HOURS_PER_INTERVAL)))),
                interruptible=interruptible,
                scheduled_start=start,
            )
        )

    for kind in house.appliances:
        if kind == "ev" and rng.random() < (0.5 if weekend else 0.85):
            arrival = float(np.clip(rng.normal(18.6, 0.5), 17.25, 20.5))
            add("ev", "highly_deferrable", 3.3, rng.uniform(5.0, 10.0), arrival, _time_index(day + 1, 7.0), True)
        elif kind == "pump":
            if rng.random() < 0.75:
                start = float(np.clip(rng.normal(18.6, 0.6), 17.5, 20.5))
                add("pump", "flexible", 1.1, 1.1 * 0.75, start, _time_index(day + 1, 6.0), False)
            else:
                start = float(np.clip(rng.normal(6.5, 0.4), 5.5, 7.5))
                add("pump", "flexible", 1.1, 1.1 * 0.75, start, _time_index(day, 10.0), False)
        elif kind == "washer" and rng.random() < (0.7 if weekend else 0.4):
            if weekend and rng.random() < 0.5:
                start = float(np.clip(rng.normal(10.0, 1.0), 8.0, 13.0))
                add("washer", "flexible", 0.9, 0.9, start, _time_index(day, 22.0), False)
            else:
                start = float(np.clip(rng.normal(19.6, 0.9), 18.0, 22.0))
                add("washer", "flexible", 0.9, 0.9, start, _time_index(day + 1, 12.0), False)
        elif kind == "geyser" and rng.random() < (0.9 if morning_temp_c < 22.0 else 0.15):
            start = float(np.clip(rng.normal(6.75, 0.4), 5.75, 8.0))
            add("geyser", "flexible", 2.0, 1.0, start, _time_index(day, start + 1.5), False)
    return events


def bake_events(events: list[ApplianceEvent], array: np.ndarray, end_index: int):
    """Add events running on their default schedule into a demand array (history)."""
    for event in events:
        for index, kw in event.projected_draw(event.default_start, event.default_start).items():
            if index < end_index:
                array[index] += kw
