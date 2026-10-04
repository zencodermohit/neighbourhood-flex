import os
from datetime import datetime


def _env_float(name: str, default: float) -> float:
    return float(os.getenv(name, str(default)))


# Simulation clock. The live simulation starts on a hot pre-monsoon afternoon so
# the first evening peak arrives a few minutes after pressing "Run".
SIM_START = datetime.fromisoformat(os.getenv("FLEX_SIM_START", "2026-05-14T15:00:00"))
INTERVAL_MINUTES = 15
INTERVALS_PER_DAY = 24 * 60 // INTERVAL_MINUTES
HISTORY_DAYS = 365
FUTURE_DAYS = 60
SECONDS_PER_INTERVAL = _env_float("FLEX_SECONDS_PER_INTERVAL", 2.0)
RANDOM_SEED = int(os.getenv("FLEX_RANDOM_SEED", "7"))

# Distribution transformer serving the 20 houses.
TRANSFORMER_RATING_KVA = _env_float("FLEX_TRANSFORMER_KVA", 50)
SAFE_LIMIT_KW = _env_float("FLEX_SAFE_LIMIT_KW", 40)
PHASE_LIMIT_KW = _env_float("FLEX_PHASE_LIMIT_KW", 16)
NOMINAL_VOLTAGE_V = 240.0

# Forecasting.
FORECAST_HORIZON_STEPS = 4  # 15, 30, 45 and 60 minutes ahead
FORECAST_BAND_Z = 1.28  # 80% interval
HOLDOUT_DAYS = 30

# Flexibility planning.
SHIFT_SAFETY_MARGIN = 1.2  # request more than the gap because not every household accepts
VALLEY_TARGET_FRACTION = 0.85  # shifted load may only land where the transformer stays below this
PENDING_ACTION_EXPIRY_INTERVALS = 2
PHASE_IMBALANCE_TRIGGER_PCT = 20.0
PHASE_CREW_DELAY_INTERVALS = 8  # utility field crew executes an approved reassignment 2 hours later
PHASE_ACTION_COOLDOWN_INTERVALS = INTERVALS_PER_DAY
PEAK_WINDOW_HOURS = (18, 22)

# Edge gateway fault injection.
METER_MISSING_PROB = 0.01
METER_SPIKE_PROB = 0.003
METER_STUCK_PROB = 0.004

# Transformer meter versus the sum of smart meters.
MISMATCH_TOLERANCE_FRACTION = 0.05

HISTORY_WINDOW_INTERVALS = INTERVALS_PER_DAY  # intervals sent to the dashboard chart
