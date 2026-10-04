"""Synthetic weather for a Pune-like climate.

Real weather and its forecast would come from a weather service. Here a year of
history plus the simulated future is generated once, deterministically, so the
forecasting model has seasonal and temperature-driven patterns to learn.
"""

from dataclasses import dataclass

import numpy as np

# Monthly mean temperature (C), diurnal amplitude (C) and mean cloud cover (0-1).
MONTHLY_MEAN_C = [21.0, 23.0, 27.0, 30.0, 31.0, 28.0, 25.5, 25.0, 25.5, 25.5, 23.0, 21.0]
MONTHLY_AMPLITUDE_C = [7.5, 8.0, 8.5, 8.0, 7.0, 4.5, 3.0, 3.0, 3.5, 5.5, 7.0, 7.5]
MONTHLY_CLOUD = [0.10, 0.10, 0.12, 0.15, 0.25, 0.65, 0.80, 0.80, 0.65, 0.35, 0.20, 0.12]


@dataclass(slots=True)
class WeatherSeries:
    temperature_c: np.ndarray
    cloud: np.ndarray
    solar_factor: np.ndarray
    temperature_forecast_error: np.ndarray  # [interval, horizon] added to the true value
    solar_forecast_error: np.ndarray


def _monthly_interp(values: list[float], day_of_year: np.ndarray) -> np.ndarray:
    # Mid-month anchors, wrapped around the year.
    anchors = np.array([15 + 30.4 * month for month in range(12)])
    xs = np.concatenate([anchors - 365, anchors, anchors + 365])
    ys = np.array(values * 3)
    return np.interp(day_of_year, xs, ys)


def build_weather(
    day_of_year: np.ndarray,
    hour: np.ndarray,
    day_index: np.ndarray,
    horizon_steps: int,
    rng: np.random.Generator,
) -> WeatherSeries:
    n_days = int(day_index.max()) + 1

    daily_anomaly = np.zeros(n_days)
    for day in range(1, n_days):
        daily_anomaly[day] = 0.75 * daily_anomaly[day - 1] + rng.normal(0, 1.2)
    daily_cloud_noise = rng.normal(0, 0.15, n_days)

    mean = _monthly_interp(MONTHLY_MEAN_C, day_of_year) + daily_anomaly[day_index]
    amplitude = _monthly_interp(MONTHLY_AMPLITUDE_C, day_of_year)
    temperature = mean + amplitude * np.cos(2 * np.pi * (hour - 15.0) / 24.0)

    cloud = np.clip(_monthly_interp(MONTHLY_CLOUD, day_of_year) + daily_cloud_noise[day_index], 0.0, 1.0)
    clear_sky = np.clip(np.sin(np.pi * (hour - 6.25) / 12.5), 0.0, None)
    solar_factor = clear_sky * (1 - 0.75 * cloud)

    n = len(hour)
    steps = np.arange(1, horizon_steps + 1)
    temperature_error = rng.normal(0, 1, (n, horizon_steps)) * (0.3 + 0.15 * steps)
    solar_error = rng.normal(0, 1, (n, horizon_steps)) * (0.04 * steps)

    return WeatherSeries(
        temperature_c=temperature,
        cloud=cloud,
        solar_factor=solar_factor,
        temperature_forecast_error=temperature_error,
        solar_forecast_error=solar_error,
    )
