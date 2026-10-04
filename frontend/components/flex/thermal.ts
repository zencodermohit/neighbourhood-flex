/**
 * Steady-state winding hot-spot estimate after IEEE C57.91 (ONAN, 65 °C rise).
 *
 * It answers "how hard is the transformer working right now?" in the units an
 * asset engineer uses. It is a steady-state estimate from the present load and
 * ambient temperature, not a measured value, and ignores thermal time constants.
 */
const RATED_TOP_OIL_RISE = 55; // °C over ambient at rated load
const RATED_HOT_SPOT_GRADIENT = 25; // °C hot spot over top oil at rated load
const LOSS_RATIO = 5; // load losses / no-load losses at rated load
const OIL_EXPONENT = 0.8; // n, ONAN
const WINDING_EXPONENT = 0.8; // m, ONAN
const REFERENCE_HOT_SPOT = 110; // °C, ageing factor 1.0

export type ThermalEstimate = {
  loadFactor: number;
  topOilC: number;
  hotSpotC: number;
  ageingFactor: number;
  status: "normal" | "near_limit" | "overloaded";
};

export function estimateThermal(apparentKva: number, ratingKva: number, ambientC: number): ThermalEstimate {
  const k = apparentKva / ratingKva;
  const topOilRise = RATED_TOP_OIL_RISE * Math.pow((k * k * LOSS_RATIO + 1) / (LOSS_RATIO + 1), OIL_EXPONENT);
  const hotSpotRise = RATED_HOT_SPOT_GRADIENT * Math.pow(k, 2 * WINDING_EXPONENT);
  const hotSpot = ambientC + topOilRise + hotSpotRise;
  const ageingFactor = Math.exp(15000 / (REFERENCE_HOT_SPOT + 273) - 15000 / (hotSpot + 273));
  return {
    loadFactor: k,
    topOilC: ambientC + topOilRise,
    hotSpotC: hotSpot,
    ageingFactor,
    status: ageingFactor >= 2 ? "overloaded" : ageingFactor >= 1 ? "near_limit" : "normal",
  };
}
