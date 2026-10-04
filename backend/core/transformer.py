"""Transformer-side measurement.

The transformer meter sees the physical load on each phase: the houses' net
demand plus losses and unmetered load such as street lighting, with its own
measurement error. It is compared with the sum of smart meters to check data
consistency, not assumed to be equal to it.
"""

import numpy as np

from config import MISMATCH_TOLERANCE_FRACTION, NOMINAL_VOLTAGE_V, PHASE_LIMIT_KW

PHASES = ("L1", "L2", "L3")
NO_LOAD_LOSS_KW_PER_PHASE = 0.05
COPPER_LOSS_COEFF = 0.02 / PHASE_LIMIT_KW  # about 2% loss at the phase limit
STREET_LIGHT_KW_PER_PHASE = 0.4
METER_ERROR_FRACTION = 0.004


def street_lighting_kw(hour: np.ndarray | float) -> np.ndarray | float:
    on = (np.asarray(hour) >= 18.5) | (np.asarray(hour) < 6.0)
    return np.where(on, STREET_LIGHT_KW_PER_PHASE, 0.0)


def losses_kw(phase_net_kw: np.ndarray | float) -> np.ndarray | float:
    return NO_LOAD_LOSS_KW_PER_PHASE + COPPER_LOSS_COEFF * np.square(phase_net_kw)


def expected_transformer_kw(phase_net_kw: np.ndarray | float, hour: np.ndarray | float) -> np.ndarray | float:
    """What the transformer should measure for a given metered net demand."""
    return phase_net_kw + street_lighting_kw(hour) + losses_kw(phase_net_kw)


def measure(true_phase_net_kw: dict[str, float], hour: float, rng: np.random.Generator) -> dict[str, dict]:
    phases = {}
    for phase in PHASES:
        net = true_phase_net_kw[phase]
        kw = float(expected_transformer_kw(net, hour)) * (1 + rng.normal(0, METER_ERROR_FRACTION))
        voltage = NOMINAL_VOLTAGE_V + 2.0 - 0.55 * kw
        power_factor = float(np.clip(0.97 - 0.015 * kw / PHASE_LIMIT_KW * 3, 0.88, 0.99))
        current = kw * 1000 / (voltage * power_factor) if kw > 0 else 0.0
        phases[phase] = {
            "kw": round(kw, 3),
            "voltage_v": round(voltage, 1),
            "current_a": round(current, 1),
            "power_factor": round(power_factor, 3),
        }
    return phases


def consistency_check(
    transformer_total_kw: float,
    meters_net_kw: dict[str, float],
    hour: float,
    flagged_readings: int = 0,
) -> dict:
    meters_total = sum(meters_net_kw.values())
    expected_extra = sum(
        float(street_lighting_kw(hour)) + float(losses_kw(meters_net_kw[phase])) for phase in PHASES
    )
    difference = transformer_total_kw - meters_total
    unexplained = difference - expected_extra
    tolerance = max(MISMATCH_TOLERANCE_FRACTION * transformer_total_kw, 0.75)
    if abs(unexplained) <= tolerance:
        status = "consistent"
    elif flagged_readings:
        status = "flagged_readings"  # explained by readings the gateway repaired
    else:
        status = "check_meters"  # unexplained: meter fault, tampering or unmetered load
    return {
        "meters_sum_kw": round(meters_total, 3),
        "difference_kw": round(difference, 3),
        "difference_pct": round(difference / transformer_total_kw * 100, 2) if transformer_total_kw else 0.0,
        "expected_losses_kw": round(sum(float(losses_kw(meters_net_kw[phase])) for phase in PHASES), 3),
        "unmetered_kw": round(3 * float(street_lighting_kw(hour)), 3),
        "unexplained_kw": round(unexplained, 3),
        "status": status,
    }
