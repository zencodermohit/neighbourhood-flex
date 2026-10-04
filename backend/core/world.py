"""The simulated neighbourhood: timeline, weather, houses and a year of history."""

from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np

from config import (
    FORECAST_HORIZON_STEPS,
    FUTURE_DAYS,
    HISTORY_DAYS,
    INTERVAL_MINUTES,
    INTERVALS_PER_DAY,
    RANDOM_SEED,
    SIM_START,
)
from core.forecasting import CalendarFeatures
from core.households import PHASES, House, base_components, bake_events, build_houses, generate_events
from core.transformer import expected_transformer_kw
from core.weather import WeatherSeries, build_weather


@dataclass
class World:
    timeline_start: datetime
    now_index: int
    size: int
    hour: np.ndarray
    weekend: np.ndarray
    day_index: np.ndarray
    weather: WeatherSeries
    calendar: CalendarFeatures
    houses: list[House]
    noise: np.ndarray  # [house, interval] multiplicative load noise
    critical: np.ndarray  # [house, interval]
    essential: np.ndarray
    flexible: np.ndarray  # history only, appliance events on default schedule
    deferrable: np.ndarray
    generation: np.ndarray
    house_net: np.ndarray  # metered net demand, history then live
    phase_demand: dict[str, np.ndarray]  # gross metered demand, history then live
    transformer_total: np.ndarray  # history then live
    transformer_phase: dict[str, np.ndarray]

    def timestamp(self, index: int) -> datetime:
        return self.timeline_start + timedelta(minutes=INTERVAL_MINUTES * index)

    def morning_temperature(self, day: int) -> float:
        return float(self.weather.temperature_c[min(day * INTERVALS_PER_DAY + 24, self.size - 1)])

    def phase_of(self) -> dict[str, str]:
        return {house.house_id: house.phase for house in self.houses}

    def rebuild_phase_series(self, end_index: int):
        """Recompute per-phase history from per-house history after a phase change."""
        for phase in PHASES:
            members = [i for i, house in enumerate(self.houses) if house.phase == phase]
            gross = (self.house_net[members, :end_index] + self.generation[members, :end_index]).sum(axis=0)
            self.phase_demand[phase][:end_index] = gross


def build_world() -> World:
    rng = np.random.default_rng(RANDOM_SEED)
    timeline_start = datetime.combine(SIM_START.date(), datetime.min.time()) - timedelta(days=HISTORY_DAYS)
    now_index = int((SIM_START - timeline_start).total_seconds() // (INTERVAL_MINUTES * 60))
    size = (HISTORY_DAYS + FUTURE_DAYS) * INTERVALS_PER_DAY

    minutes = np.arange(size) * INTERVAL_MINUTES
    day_index = minutes // (24 * 60)
    hour = (minutes % (24 * 60)) / 60.0
    first_weekday = timeline_start.weekday()
    weekday = (first_weekday + day_index) % 7
    weekend = weekday >= 5
    first_day_of_year = timeline_start.timetuple().tm_yday
    day_of_year = (first_day_of_year - 1 + day_index) % 365 + hour / 24

    weather = build_weather(day_of_year, hour, day_index, FORECAST_HORIZON_STEPS, rng)
    calendar = CalendarFeatures(
        hour=hour,
        weekend=weekend,
        temperature_c=weather.temperature_c,
        temperature_error=weather.temperature_forecast_error,
    )

    houses = build_houses()
    n_houses = len(houses)
    noise = np.exp(rng.normal(0, 0.12, (n_houses, size)))
    critical = np.zeros((n_houses, size))
    essential = np.zeros((n_houses, size))
    generation = np.zeros((n_houses, size))
    pv_noise = np.clip(1 + rng.normal(0, 0.05, (n_houses, size)), 0.8, 1.2)
    for i, house in enumerate(houses):
        critical[i], essential[i] = base_components(house, hour, weekend, weather.temperature_c, noise[i])
        generation[i] = house.pv_kw * weather.solar_factor * pv_noise[i]

    flexible = np.zeros((n_houses, size))
    deferrable = np.zeros((n_houses, size))
    n_history_days = now_index // INTERVALS_PER_DAY + 1
    world = World(
        timeline_start=timeline_start,
        now_index=now_index,
        size=size,
        hour=hour,
        weekend=weekend,
        day_index=day_index,
        weather=weather,
        calendar=calendar,
        houses=houses,
        noise=noise,
        critical=critical,
        essential=essential,
        flexible=flexible,
        deferrable=deferrable,
        generation=generation,
        house_net=np.zeros((n_houses, size)),
        phase_demand={phase: np.zeros(size) for phase in PHASES},
        transformer_total=np.zeros(size),
        transformer_phase={phase: np.zeros(size) for phase in PHASES},
    )

    for i, house in enumerate(houses):
        for day in range(n_history_days):
            day_weekend = bool(weekend[min(day * INTERVALS_PER_DAY, size - 1)])
            events = generate_events(house, day, day_weekend, world.morning_temperature(day), RANDOM_SEED)
            # Events that start after the simulation start belong to the live simulation.
            history_events = [event for event in events if event.default_start < now_index]
            bake_events([e for e in history_events if e.load_class == "flexible"], flexible[i], now_index)
            bake_events([e for e in history_events if e.load_class == "highly_deferrable"], deferrable[i], now_index)

    gross = critical + essential + flexible + deferrable
    world.house_net[:, :now_index] = (gross - generation)[:, :now_index]
    world.rebuild_phase_series(now_index)
    for phase in PHASES:
        members = [i for i, house in enumerate(houses) if house.phase == phase]
        net = world.house_net[members, :now_index].sum(axis=0)
        world.transformer_phase[phase][:now_index] = expected_transformer_kw(net, hour[:now_index])
    world.transformer_total[:now_index] = sum(world.transformer_phase[phase][:now_index] for phase in PHASES)
    return world
