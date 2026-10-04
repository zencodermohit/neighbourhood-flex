export type PhaseName = "L1" | "L2" | "L3";
export type LoadStatus = "normal" | "near_limit" | "overloaded";
export type LoadClass = "critical" | "essential" | "flexible" | "highly_deferrable";

export type PhaseState = {
  phase: PhaseName;
  kw: number;
  limit_kw: number;
  loading_pct: number;
  voltage_v: number;
  current_a: number;
  power_factor: number;
  status: LoadStatus;
  houses: string[];
};

export type Consistency = {
  meters_sum_kw: number;
  difference_kw: number;
  difference_pct: number;
  expected_losses_kw: number;
  unmetered_kw: number;
  unexplained_kw: number;
  status: "consistent" | "flagged_readings" | "check_meters";
};

export type ForecastHorizon = {
  minutes: number;
  time: string;
  demand_kw: number;
  solar_kw: number;
  net_kw: number;
  adjusted_kw: number;
  lower_kw: number;
  upper_kw: number;
  phases: Record<PhaseName, number>;
  gap_kw: number;
  phase_gap_kw: Record<PhaseName, number>;
  temperature_c: number;
};

export type ShiftRequest = {
  event_id: string;
  house_id: string;
  phase: PhaseName;
  appliance: string;
  load_class: LoadClass;
  power_kw: number;
  relief_kw: number;
  accept_prob: number;
  original_start: string;
  new_start: string;
  deadline: string;
  message: string;
  response: "pending" | "accepted" | "declined" | "expired";
};

export type ShiftVerification = {
  status: "in_progress" | "resolved" | "limit_exceeded";
  planned_kw: number;
  committed_kw: number;
  delivered_kw: number;
  measured_kw: number | null;
  peak_total_kw: number;
  peak_phase_kw: Record<PhaseName, number>;
  intervals_observed: number;
};

export type PhaseVerification = {
  status: "measuring" | "improved" | "not_improved";
  peak_intervals_observed: number;
  measured_phase_kw?: Record<PhaseName, number>;
  measured_imbalance_pct?: number;
};

type ActionBase = {
  id: string;
  status:
    | "pending_approval"
    | "dispatched"
    | "verifying"
    | "verified"
    | "expired"
    | "rejected"
    | "crew_scheduled"
    | "executed";
  created_at: string;
  summary: string;
};

export type TimeShiftAction = ActionBase & {
  type: "time_shift";
  window_start: string;
  window_end: string;
  need_kw: number;
  need_phase_kw: Record<PhaseName, number>;
  expected_kw: number;
  committed_kw: number;
  residual_kw: number;
  requests: ShiftRequest[];
  verification: ShiftVerification | null;
};

export type PhaseMove = {
  house_id: string;
  label: string;
  from_phase: PhaseName;
  to_phase: PhaseName;
  peak_window_kw: number;
};

export type PhaseAction = ActionBase & {
  type: "phase_rebalance";
  moves: PhaseMove[];
  phase_peak_before_kw: Record<PhaseName, number>;
  phase_peak_after_kw: Record<PhaseName, number>;
  imbalance_before_pct: number;
  imbalance_after_pct: number;
  note: string;
  execute_at?: string;
  executed_at?: string;
  verification: PhaseVerification | null;
};

export type FlexAction = TimeShiftAction | PhaseAction;

export type Escalation = {
  id: string;
  status: "open" | "acknowledged";
  created_at: string;
  window_start: string;
  window_end: string;
  residual_kw: number;
  where: string;
  reason: string;
  recommendation: string;
};

export type Meter = {
  house_id: string;
  label: string;
  phase: PhaseName;
  consumption_kw: number;
  generation_kw: number;
  net_kw: number;
  flag: "ok" | "imputed_missing" | "rejected_spike" | "stuck";
  enrolled: boolean;
  medical: boolean;
  accept_prob: number;
  pv_kw: number;
  running: string[];
  shifted: boolean;
};

export type HistoryPoint = {
  time: string;
  total_kw: number;
  without_kw: number;
  phases: Record<PhaseName, number>;
  forecast_kw: number | null;
  limit_kw: number;
  simulated: boolean;
};

export type FlexState = {
  clock: {
    time: string;
    interval_end: string;
    weekday: string;
    running: boolean;
    seconds_per_interval: number;
    in_peak_window: boolean;
    interval_minutes: number;
  };
  config: {
    safe_limit_kw: number;
    phase_limit_kw: number;
    auto_dispatch: boolean;
    temperature_offset_c: number;
    transformer_rating_kva: number;
    horizon_minutes: number;
  };
  weather: { temperature_c: number; cloud_pct: number; solar_factor: number };
  transformer: {
    total_kw: number;
    loading_pct: number;
    apparent_kva: number;
    rating_pct: number;
    status: LoadStatus;
    phases: PhaseState[];
    imbalance_pct: number;
    consistency: Consistency;
  };
  demand: {
    gross_kw: number;
    solar_kw: number;
    net_kw: number;
    avg_per_house_kw: number;
    by_class: Record<LoadClass, number>;
    eligible_shiftable_kw: number;
  };
  quality: {
    meters: number;
    counts: Record<Meter["flag"], number>;
    score_pct: number;
    issues: { time: string; house_id: string; issue: Meter["flag"]; detail: string }[];
  };
  forecast: {
    horizons: ForecastHorizon[];
    model: {
      type: string;
      features: string[];
      training_days: number;
      holdout: Record<string, { mae_kw: number; mape_pct: number }>;
      live_mae_15_kw: number | null;
      data_note: string;
    };
  };
  gap: {
    status: "gap" | "clear";
    total_gap_kw: number;
    phase_gap_kw: Record<PhaseName, number>;
    worst_minutes: number | null;
    worst_time: string | null;
    time_shift_requested_kw: number;
    time_shift_expected_kw: number;
    residual_kw: number;
  };
  phase_balance: {
    imbalance_now_pct: number;
    peak_window_kw: Record<PhaseName, number>;
    peak_window_imbalance_pct: number;
  };
  actions: FlexAction[];
  escalations: Escalation[];
  meters: Meter[];
  history: HistoryPoint[];
  totals: {
    intervals: number;
    intervals_over_limit: number;
    intervals_over_limit_without: number;
    requests_sent: number;
    requests_accepted: number;
    requests_declined: number;
    energy_shifted_kwh: number;
    escalations: number;
    meter_issues: number;
  };
};
