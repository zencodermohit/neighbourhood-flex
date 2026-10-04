"""Demand forecasting for the transformer's three phases.

One ridge regression per phase and horizon (15 to 60 minutes ahead) predicts
gross household demand from recent demand, the same time yesterday and last
week, the temperature forecast and the calendar. It is fitted on the year of
history and checked on the last 30 days, which are held out first.

Solar generation is forecast separately from installed PV capacity and the
irradiance forecast; net demand is demand minus solar.
"""

from dataclasses import dataclass, field

import numpy as np

from config import HOLDOUT_DAYS, INTERVALS_PER_DAY

PHASES = ("L1", "L2", "L3")
WEEK = 7 * INTERVALS_PER_DAY
RIDGE_LAMBDA = 1.0
FEATURE_NAMES = (
    "demand now",
    "demand 15 min ago",
    "demand 30 min ago",
    "demand 45 min ago",
    "same time yesterday",
    "same time last week",
    "forecast temperature",
    "cooling degrees",
    "cooling degrees squared",
    "time of day (4 harmonics)",
    "weekend",
)


@dataclass(slots=True)
class CalendarFeatures:
    hour: np.ndarray
    weekend: np.ndarray
    temperature_c: np.ndarray
    temperature_error: np.ndarray  # [interval, horizon]


def _features(
    series: np.ndarray,
    origins: np.ndarray,
    horizon: int,
    calendar: CalendarFeatures,
    temperature_offset: float = 0.0,
) -> np.ndarray:
    target = origins + horizon
    temperature = calendar.temperature_c[target] + calendar.temperature_error[origins, horizon - 1] + temperature_offset
    cooling = np.clip(temperature - 26.0, 0.0, None)
    hour = calendar.hour[target]
    weekend = calendar.weekend[target].astype(float)
    columns = [
        series[origins],
        series[origins - 1],
        series[origins - 2],
        series[origins - 3],
        series[target - INTERVALS_PER_DAY],
        series[target - WEEK],
        temperature,
        cooling,
        cooling**2 / 10,
    ]
    for k in range(1, 5):
        columns.append(np.sin(2 * np.pi * k * hour / 24))
        columns.append(np.cos(2 * np.pi * k * hour / 24))
    columns += [
        weekend,
        weekend * np.sin(2 * np.pi * hour / 24),
        weekend * np.cos(2 * np.pi * hour / 24),
    ]
    return np.column_stack(columns)


@dataclass
class RidgeModel:
    mean: np.ndarray
    scale: np.ndarray
    weights: np.ndarray
    intercept: float

    @classmethod
    def fit(cls, features: np.ndarray, target: np.ndarray) -> "RidgeModel":
        mean = features.mean(axis=0)
        scale = features.std(axis=0)
        scale[scale == 0] = 1.0
        standardized = (features - mean) / scale
        intercept = float(target.mean())
        gram = standardized.T @ standardized + RIDGE_LAMBDA * np.eye(standardized.shape[1])
        weights = np.linalg.solve(gram, standardized.T @ (target - intercept))
        return cls(mean=mean, scale=scale, weights=weights, intercept=intercept)

    def predict(self, features: np.ndarray) -> np.ndarray:
        return ((features - self.mean) / self.scale) @ self.weights + self.intercept


@dataclass
class DemandForecaster:
    horizons: int
    models: dict[tuple[str, int], RidgeModel] = field(default_factory=dict)
    residual_std: dict[int, float] = field(default_factory=dict)
    holdout_metrics: dict[int, dict[str, float]] = field(default_factory=dict)
    trained_until: int = 0
    training_intervals: int = 0

    def fit(self, phase_demand: dict[str, np.ndarray], end_index: int, calendar: CalendarFeatures):
        """Fit on intervals before end_index, after first scoring a 30-day holdout."""
        holdout_start = end_index - HOLDOUT_DAYS * INTERVALS_PER_DAY
        first_origin = WEEK

        for horizon in range(1, self.horizons + 1):
            train_origins = np.arange(first_origin, holdout_start - horizon)
            test_origins = np.arange(holdout_start, end_index - horizon)
            total_prediction = np.zeros(len(test_origins))
            total_actual = np.zeros(len(test_origins))
            for phase in PHASES:
                series = phase_demand[phase]
                model = RidgeModel.fit(_features(series, train_origins, horizon, calendar), series[train_origins + horizon])
                total_prediction += model.predict(_features(series, test_origins, horizon, calendar))
                total_actual += series[test_origins + horizon]
            errors = total_prediction - total_actual
            self.residual_std[horizon] = float(errors.std())
            self.holdout_metrics[horizon] = {
                "mae_kw": round(float(np.abs(errors).mean()), 3),
                "mape_pct": round(float((np.abs(errors) / np.maximum(total_actual, 1.0)).mean() * 100), 2),
            }

        self.refit(phase_demand, end_index, calendar)

    def refit(self, phase_demand: dict[str, np.ndarray], end_index: int, calendar: CalendarFeatures):
        """Refit on all data up to end_index, for example after a phase reassignment."""
        for horizon in range(1, self.horizons + 1):
            origins = np.arange(WEEK, end_index - horizon)
            for phase in PHASES:
                series = phase_demand[phase]
                self.models[(phase, horizon)] = RidgeModel.fit(
                    _features(series, origins, horizon, calendar), series[origins + horizon]
                )
        self.trained_until = end_index
        self.training_intervals = end_index - WEEK

    def predict(
        self,
        phase_demand: dict[str, np.ndarray],
        origin: int,
        calendar: CalendarFeatures,
        temperature_offset: float = 0.0,
    ) -> dict[int, dict[str, float]]:
        origins = np.array([origin])
        forecast: dict[int, dict[str, float]] = {}
        for horizon in range(1, self.horizons + 1):
            forecast[horizon] = {
                phase: max(
                    float(
                        self.models[(phase, horizon)].predict(
                            _features(phase_demand[phase], origins, horizon, calendar, temperature_offset)
                        )[0]
                    ),
                    0.0,
                )
                for phase in PHASES
            }
        return forecast
