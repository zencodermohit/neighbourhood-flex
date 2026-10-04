"use client";

import {
  ArrowRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  HeartPulse,
  Hourglass,
  OctagonAlert,
  Sun,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { CLASS_META, COLORS, STATUS_META, clock, kw, pct } from "@/components/flex/format";
import type {
  Escalation,
  FlexAction,
  FlexState,
  LoadClass,
  Meter,
  PhaseAction,
  PhaseName,
  ShiftRequest,
  TimeShiftAction,
} from "@/components/flex/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const PHASES: PhaseName[] = ["L1", "L2", "L3"];

export function Panel({
  title,
  description,
  children,
  aside,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-start justify-between gap-4 pb-4">
        <div className="space-y-1.5">
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {aside}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/50 p-3">
      <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">{label}</p>
      <p className="mt-2 text-lg font-semibold tabular-nums text-white">{value}</p>
      {sub ? <div className="mt-0.5 text-xs text-zinc-400">{sub}</div> : null}
    </div>
  );
}

export function StatusPill({ status }: { status: keyof typeof STATUS_META }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-xs text-white">
      <meta.Icon aria-hidden className="size-3.5" style={{ color: meta.color }} />
      {meta.label}
    </span>
  );
}

function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warn" | "bad" }) {
  const color = { neutral: undefined, good: COLORS.good, warn: COLORS.warning, bad: COLORS.critical }[tone];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-zinc-300">
      {color ? <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: color }} /> : null}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- flow strip

export function FlowStrip({ state }: { state: FlexState }) {
  const pendingApprovals = state.actions.filter((action) => action.status === "pending_approval").length;
  const verifying = state.actions.filter((action) => ["dispatched", "verifying", "crew_scheduled", "executed"].includes(action.status)).length;
  const openEscalations = state.escalations.filter((escalation) => escalation.status === "open").length;
  const worst = state.forecast.horizons.reduce((max, horizon) => Math.max(max, horizon.adjusted_kw), 0);
  const steps = [
    { name: "Sense", value: `${state.quality.meters} meters · ${pct(state.quality.score_pct)} valid`, alert: state.quality.score_pct < 90 },
    { name: "Forecast", value: `peak ${kw(worst)} next ${state.config.horizon_minutes} min`, alert: false },
    {
      name: "Detect",
      value: state.gap.status === "gap" ? `gap ${kw(Math.max(state.gap.total_gap_kw, ...Object.values(state.gap.phase_gap_kw)))}` : "no gap",
      alert: state.gap.status === "gap",
    },
    { name: "Act", value: pendingApprovals ? `${pendingApprovals} awaiting approval` : `${state.totals.requests_accepted} requests accepted`, alert: pendingApprovals > 0 },
    { name: "Verify", value: openEscalations ? `${openEscalations} escalated` : `${verifying} in progress`, alert: openEscalations > 0 },
  ];
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {steps.map((step, index) => (
        <li key={step.name} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-white/15 text-[11px] text-zinc-400">
            {index + 1}
          </span>
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">{step.name}</p>
            <p className="flex items-center gap-1.5 truncate text-sm text-white">
              {step.alert ? <TriangleAlert aria-hidden className="size-3.5 shrink-0" style={{ color: COLORS.warning }} /> : null}
              {step.value}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// --------------------------------------------------------------- transformer

function LoadBar({ value, limit, status }: { value: number; limit: number; status: keyof typeof STATUS_META }) {
  const max = Math.max(limit * 1.3, value * 1.05);
  return (
    <div className="relative h-3 rounded-full bg-white/[0.06]">
      <div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${Math.min(value / max, 1) * 100}%`, backgroundColor: status === "normal" ? COLORS.actual : STATUS_META[status].color }}
      />
      <div aria-hidden className="absolute -inset-y-1 w-0.5 bg-zinc-300" style={{ left: `${(limit / max) * 100}%` }} title="Limit" />
    </div>
  );
}

export function TransformerPanel({ state }: { state: FlexState }) {
  const { transformer, config } = state;
  const consistency = transformer.consistency;
  const consistencyText = {
    consistent: "Consistent: difference explained by losses and street lighting",
    flagged_readings: "Difference explained by readings the gateway repaired",
    check_meters: "Unexplained difference: check meters, tampering or unmetered load",
  }[consistency.status];
  return (
    <Panel
      aside={<StatusPill status={transformer.status} />}
      description={`${config.transformer_rating_kva} kVA distribution transformer, 20 houses on L1/L2/L3`}
      title="Transformer"
    >
      <div className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-4xl font-semibold tabular-nums text-white">{kw(transformer.total_kw)}</p>
            <p className="mt-1 text-sm text-zinc-400">
              {pct(transformer.loading_pct)} of the {config.safe_limit_kw} kW safe limit · {transformer.apparent_kva.toFixed(1)} kVA (
              {pct(transformer.rating_pct)} of rating)
            </p>
          </div>
        </div>
        <LoadBar limit={config.safe_limit_kw} status={transformer.status} value={transformer.total_kw} />
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Sum of 20 meters" sub="net of rooftop solar" value={kw(consistency.meters_sum_kw)} />
          <Stat
            label="Transformer − meters"
            sub={`losses ${kw(consistency.expected_losses_kw, 2)} · street lights ${kw(consistency.unmetered_kw, 1)}`}
            value={`${kw(consistency.difference_kw, 2)} (${pct(consistency.difference_pct, 1)})`}
          />
        </div>
        <p className="flex items-start gap-2 text-sm text-zinc-400">
          {consistency.status === "consistent" ? (
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: COLORS.good }} />
          ) : (
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: COLORS.warning }} />
          )}
          {consistencyText}
          {consistency.status !== "consistent" ? ` (unexplained ${kw(consistency.unexplained_kw, 2)})` : ""}
        </p>
      </div>
    </Panel>
  );
}

export function PhasePanel({ state }: { state: FlexState }) {
  const { transformer, phase_balance: balance, config } = state;
  return (
    <Panel
      aside={<Chip tone={transformer.imbalance_pct > 20 ? "warn" : "good"}>imbalance {pct(transformer.imbalance_pct)}</Chip>}
      description={`Per-phase limit ${config.phase_limit_kw} kW. Imbalance = (max − mean) / mean.`}
      title="Phase loading"
    >
      <div className="space-y-4">
        {transformer.phases.map((phase) => (
          <div key={phase.phase} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium text-white">
                {phase.phase} <span className="font-normal text-zinc-500">· {phase.houses.length} houses</span>
              </span>
              <span className="tabular-nums text-white">
                {kw(phase.kw)} <span className="text-zinc-500">/ {phase.limit_kw}</span>
              </span>
            </div>
            <LoadBar limit={phase.limit_kw} status={phase.status} value={phase.kw} />
            <p className="flex flex-wrap gap-x-3 text-xs text-zinc-500">
              <span>{phase.voltage_v.toFixed(1)} V</span>
              <span>{phase.current_a.toFixed(0)} A</span>
              <span>PF {phase.power_factor.toFixed(2)}</span>
              {phase.status !== "normal" ? <span style={{ color: STATUS_META[phase.status].color }}>{STATUS_META[phase.status].label}</span> : null}
            </p>
          </div>
        ))}
        <div className="rounded-xl border border-white/10 bg-black/50 p-3 text-sm text-zinc-400">
          Evening peak (18:00–22:00), last 7 days:{" "}
          {PHASES.map((phase) => `${phase} ${balance.peak_window_kw[phase].toFixed(1)}`).join(" · ")} kW, imbalance{" "}
          <span className="text-white">{pct(balance.peak_window_imbalance_pct)}</span>
        </div>
      </div>
    </Panel>
  );
}

// ----------------------------------------------------------------------- gap

export function GapPanel({ state }: { state: FlexState }) {
  const { gap, forecast, config } = state;
  const worstPhase = PHASES.reduce((best, phase) => (gap.phase_gap_kw[phase] > gap.phase_gap_kw[best] ? phase : best), "L1" as PhaseName);
  const phaseGap = gap.phase_gap_kw[worstPhase];
  return (
    <Panel
      aside={gap.status === "gap" ? <StatusPill status="overloaded" /> : <StatusPill status="normal" />}
      description="Baseline = forecast demand − solar + losses at the transformer. After flex = baseline with flexibility already dispatched. Gap = after flex − limit."
      title="Flexibility gap"
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="Transformer gap"
            sub={gap.worst_time ? `worst at ${clock(gap.worst_time)}` : `next ${config.horizon_minutes} min`}
            value={kw(gap.total_gap_kw)}
          />
          <Stat label="Worst phase gap" sub={phaseGap > 0 ? `on ${worstPhase}` : "all phases within limit"} value={kw(phaseGap)} />
          <Stat label="Time-shift requested" sub={`expected ${kw(gap.time_shift_expected_kw)} after declines`} value={kw(gap.time_shift_requested_kw)} />
          <Stat label="Residual risk" sub={gap.residual_kw > 0.1 ? "escalated to DISCOM" : "covered locally"} value={kw(gap.residual_kw)} />
        </div>
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">
            <tr>
              <th className="py-1 text-left font-normal">Ahead</th>
              <th className="py-1 text-right font-normal">Demand</th>
              <th className="py-1 text-right font-normal">Solar</th>
              <th className="py-1 text-right font-normal">Baseline</th>
              <th className="py-1 text-right font-normal">After flex</th>
              <th className="py-1 text-right font-normal">Gap</th>
            </tr>
          </thead>
          <tbody>
            {forecast.horizons.map((horizon) => (
              <tr key={horizon.minutes} className="border-t border-white/5 tabular-nums">
                <td className="py-1.5 text-zinc-300">
                  {horizon.minutes} min <span className="text-zinc-500">{clock(horizon.time)}</span>
                </td>
                <td className="py-1.5 text-right">{horizon.demand_kw.toFixed(1)}</td>
                <td className="py-1.5 text-right">{horizon.solar_kw.toFixed(1)}</td>
                <td className="py-1.5 text-right">{horizon.net_kw.toFixed(1)}</td>
                <td className="py-1.5 text-right text-white">{horizon.adjusted_kw.toFixed(1)}</td>
                <td className="py-1.5 text-right" style={{ color: horizon.gap_kw > 0 ? COLORS.critical : undefined }}>
                  {horizon.gap_kw > 0 ? horizon.gap_kw.toFixed(1) : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------- actions

const ACTION_STATUS: Record<FlexAction["status"], { label: string; tone: "neutral" | "good" | "warn" | "bad" }> = {
  pending_approval: { label: "Awaiting approval", tone: "warn" },
  dispatched: { label: "Dispatched", tone: "neutral" },
  verifying: { label: "Verifying", tone: "neutral" },
  verified: { label: "Verified", tone: "good" },
  expired: { label: "Expired", tone: "neutral" },
  rejected: { label: "Rejected", tone: "neutral" },
  crew_scheduled: { label: "Crew scheduled", tone: "neutral" },
  executed: { label: "Executed, measuring", tone: "neutral" },
};

function ResponseIcon({ response }: { response: ShiftRequest["response"] }) {
  if (response === "accepted") return <CircleCheck aria-label="accepted" className="size-4" style={{ color: COLORS.good }} />;
  if (response === "declined") return <CircleX aria-label="declined" className="size-4" style={{ color: COLORS.critical }} />;
  if (response === "expired") return <Hourglass aria-label="expired" className="size-4 text-zinc-500" />;
  return <CircleDashed aria-label="pending" className="size-4 text-zinc-400" />;
}

function TimeShiftCard({ action }: { action: TimeShiftAction }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">
        Window {clock(action.window_start)}–{clock(action.window_end)} · gap {kw(action.need_kw)} · expected relief{" "}
        {kw(action.expected_kw)}
        {action.committed_kw > 0 ? ` · committed ${kw(action.committed_kw)}` : ""}
      </p>
      <ul className="space-y-1.5">
        {action.requests.map((request) => (
          <li key={request.event_id} className="flex items-center gap-3 rounded-lg bg-black/40 px-3 py-2 text-sm">
            <ResponseIcon response={request.response} />
            <span className="w-10 shrink-0 font-medium text-white">{request.house_id}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-300" title={request.message}>
              {request.appliance} · {CLASS_META[request.load_class].label.toLowerCase()} · {request.phase}
            </span>
            <span className="shrink-0 tabular-nums text-zinc-400">
              {kw(request.relief_kw)} <ArrowRight aria-hidden className="inline size-3" /> {clock(request.new_start)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PhaseCard({ action }: { action: PhaseAction }) {
  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {action.moves.map((move) => (
          <li key={move.house_id} className="flex items-center gap-3 rounded-lg bg-black/40 px-3 py-2 text-sm">
            <Wrench aria-hidden className="size-4 text-zinc-400" />
            <span className="w-10 shrink-0 font-medium text-white">{move.house_id}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-300">{move.label}</span>
            <span className="shrink-0 tabular-nums text-zinc-400">
              {move.from_phase} <ArrowRight aria-hidden className="inline size-3" /> {move.to_phase} · {kw(move.peak_window_kw)}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-zinc-400">
        Evening phase loads {PHASES.map((p) => action.phase_peak_before_kw[p].toFixed(1)).join(" / ")} →{" "}
        {PHASES.map((p) => action.phase_peak_after_kw[p].toFixed(1)).join(" / ")} kW
        {action.execute_at && action.status === "crew_scheduled" ? ` · crew executes at ${clock(action.execute_at)}` : ""}
      </p>
      <p className="text-xs text-zinc-500">{action.note}</p>
    </div>
  );
}

export function ActionQueue({
  actions,
  autoDispatch,
  onApprove,
  onReject,
  busy,
}: {
  actions: FlexAction[];
  autoDispatch: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  busy: boolean;
}) {
  const visible = actions.filter((action) => action.status !== "expired").slice(0, 8);
  return (
    <Panel
      description={
        autoDispatch
          ? "Household time-shift requests are sent automatically under the standing policy. Phase changes always need utility approval."
          : "Every action waits for operator approval. Time-shift requests expire after 30 minutes."
      }
      title="Action queue"
    >
      {visible.length === 0 ? (
        <p className="text-sm text-zinc-500">No actions yet. Run the simulation into the evening peak.</p>
      ) : (
        <ul className="space-y-3">
          {visible.map((action) => {
            const status = ACTION_STATUS[action.status];
            return (
              <li key={action.id} className="space-y-3 rounded-xl border border-white/10 bg-black/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs text-zinc-500">
                      {action.id} · {action.type === "time_shift" ? "Load time-shift" : "Phase rebalancing (planning)"} ·{" "}
                      {clock(action.created_at)}
                    </p>
                    <p className="mt-1 font-medium text-white">{action.summary}</p>
                  </div>
                  <Chip tone={status.tone}>{status.label}</Chip>
                </div>
                {action.type === "time_shift" ? <TimeShiftCard action={action} /> : <PhaseCard action={action} />}
                {action.status === "pending_approval" ? (
                  <div className="flex gap-2">
                    <Button disabled={busy} onClick={() => onApprove(action.id)} size="sm" type="button">
                      {action.type === "time_shift" ? "Approve and send" : "Approve, schedule crew"}
                    </Button>
                    <Button disabled={busy} onClick={() => onReject(action.id)} size="sm" type="button" variant="outline">
                      Reject
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// -------------------------------------------------------------- verification

export function VerificationPanel({ actions }: { actions: FlexAction[] }) {
  const verified = actions.filter((action) => action.verification).slice(0, 6);
  return (
    <Panel description="Planned versus what households delivered and what the transformer measured." title="Measurement & verification">
      {verified.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing to verify yet.</p>
      ) : (
        <ul className="space-y-2">
          {verified.map((action) =>
            action.type === "time_shift" ? (
              <li key={action.id} className="rounded-xl border border-white/10 bg-black/40 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-white">
                    {action.id} · {clock(action.window_start)}–{clock(action.window_end)}
                  </span>
                  <VerificationChip status={action.verification!.status} />
                </div>
                <div className="mt-2 grid grid-cols-4 gap-2 text-xs text-zinc-500">
                  <Metric label="Planned" value={kw(action.verification!.planned_kw)} />
                  <Metric label="Committed" value={kw(action.verification!.committed_kw)} />
                  <Metric label="Delivered" value={kw(action.verification!.delivered_kw)} />
                  <Metric label="Peak measured" value={kw(action.verification!.peak_total_kw)} />
                </div>
              </li>
            ) : (
              <li key={action.id} className="rounded-xl border border-white/10 bg-black/40 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-white">{action.id} · phase rebalancing</span>
                  <VerificationChip status={action.verification!.status} />
                </div>
                <p className="mt-2 text-xs text-zinc-400">
                  Planned imbalance {pct(action.imbalance_before_pct)} → {pct(action.imbalance_after_pct)} · measured{" "}
                  {action.verification!.measured_imbalance_pct !== undefined
                    ? pct(action.verification!.measured_imbalance_pct)
                    : "–"}{" "}
                  over {action.verification!.peak_intervals_observed} peak intervals
                </p>
              </li>
            ),
          )}
        </ul>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        Delivered = default draw of accepted appliances minus their actual draw. Planned assumes each household&apos;s
        historical acceptance rate.
      </p>
    </Panel>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p>{label}</p>
      <p className="mt-0.5 text-sm tabular-nums text-white">{value}</p>
    </div>
  );
}

function VerificationChip({ status }: { status: string }) {
  const map: Record<string, [string, "neutral" | "good" | "warn" | "bad"]> = {
    in_progress: ["In progress", "neutral"],
    measuring: ["Measuring", "neutral"],
    resolved: ["Constraint resolved", "good"],
    improved: ["Imbalance improved", "good"],
    limit_exceeded: ["Limit still exceeded", "bad"],
    not_improved: ["Not improved", "bad"],
  };
  const [label, tone] = map[status] ?? [status, "neutral"];
  return <Chip tone={tone}>{label}</Chip>;
}

export function EscalationPanel({
  escalations,
  onAcknowledge,
  busy,
}: {
  escalations: Escalation[];
  onAcknowledge: (id: string) => void;
  busy: boolean;
}) {
  return (
    <Panel description="Residual risk that local flexibility could not cover, for authorized network action." title="Escalations to DISCOM">
      {escalations.length === 0 ? (
        <p className="text-sm text-zinc-500">None. Local flexibility has covered every forecast gap so far.</p>
      ) : (
        <ul className="space-y-2">
          {escalations.slice(0, 5).map((escalation) => (
            <li key={escalation.id} className="space-y-2 rounded-xl border border-white/10 bg-black/40 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-white">
                  <OctagonAlert aria-hidden className="size-4" style={{ color: escalation.status === "open" ? COLORS.critical : COLORS.axis }} />
                  {kw(escalation.residual_kw)} on {escalation.where} · {clock(escalation.window_start)}–{clock(escalation.window_end)}
                </span>
                {escalation.status === "open" ? (
                  <Button disabled={busy} onClick={() => onAcknowledge(escalation.id)} size="sm" type="button" variant="outline">
                    Acknowledge
                  </Button>
                ) : (
                  <Chip>Acknowledged</Chip>
                )}
              </div>
              <p className="text-zinc-400">{escalation.reason}</p>
              <p className="text-xs text-zinc-500">{escalation.recommendation}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------- demand mix

export function LoadClassPanel({ state }: { state: FlexState }) {
  const { demand } = state;
  const classes = Object.keys(CLASS_META) as LoadClass[];
  const total = classes.reduce((sum, key) => sum + demand.by_class[key], 0) || 1;
  return (
    <Panel description="Demand right now by protection class. Only the last two are ever shifted." title="Load by protection class">
      <div className="space-y-4">
        <div aria-label="Demand by protection class" className="flex h-4 gap-0.5 overflow-hidden rounded-md" role="img">
          {classes.map((key) =>
            demand.by_class[key] > 0 ? (
              <div
                key={key}
                style={{ width: `${(demand.by_class[key] / total) * 100}%`, backgroundColor: CLASS_META[key].color }}
                title={`${CLASS_META[key].label}: ${kw(demand.by_class[key])}`}
              />
            ) : null,
          )}
        </div>
        <ul className="space-y-2 text-sm">
          {classes.map((key) => (
            <li key={key} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-zinc-300">
                <span aria-hidden className="size-2.5 rounded-sm" style={{ backgroundColor: CLASS_META[key].color }} />
                {CLASS_META[key].label} <span className="text-zinc-500">· {CLASS_META[key].note}</span>
              </span>
              <span className="tabular-nums text-white">{kw(demand.by_class[key])}</span>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Demand" value={kw(demand.gross_kw)} />
          <Stat label="Rooftop solar" value={kw(demand.solar_kw)} />
          <Stat label="Shiftable next hour" sub="enrolled, not yet asked" value={kw(demand.eligible_shiftable_kw)} />
        </div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------ data quality

const FLAG_LABEL: Record<Meter["flag"], string> = {
  ok: "Valid",
  imputed_missing: "Missing, imputed",
  rejected_spike: "Spike rejected",
  stuck: "Stuck register",
};

export function DataQualityPanel({ state }: { state: FlexState }) {
  const { quality } = state;
  return (
    <Panel
      aside={<Chip tone={quality.score_pct >= 95 ? "good" : quality.score_pct >= 85 ? "warn" : "bad"}>{pct(quality.score_pct)} valid</Chip>}
      description="The edge gateway time-aligns, validates and repairs every reading before forecasting."
      title="Edge gateway data quality"
    >
      <div className="space-y-3">
        <div className="grid grid-cols-4 gap-2 text-center">
          {(Object.keys(FLAG_LABEL) as Meter["flag"][]).map((flag) => (
            <div key={flag} className="rounded-xl border border-white/10 bg-black/50 p-2">
              <p className="text-lg font-semibold tabular-nums text-white">{quality.counts[flag]}</p>
              <p className="text-[11px] text-zinc-500">{FLAG_LABEL[flag]}</p>
            </div>
          ))}
        </div>
        <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Recent repairs</p>
        {quality.issues.length === 0 ? (
          <p className="text-sm text-zinc-500">No issues recently.</p>
        ) : (
          <ul className="max-h-40 space-y-1 overflow-auto text-sm">
            {quality.issues.slice(0, 8).map((issue, index) => (
              <li key={`${issue.time}-${issue.house_id}-${index}`} className="flex gap-3 text-zinc-400">
                <span className="w-11 shrink-0 tabular-nums text-zinc-500">{clock(issue.time)}</span>
                <span className="w-9 shrink-0 text-white">{issue.house_id}</span>
                <span className="min-w-0 truncate" title={issue.detail}>
                  {issue.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------- model

export function ModelPanel({ state }: { state: FlexState }) {
  const { model } = state.forecast;
  return (
    <Panel description={`${model.type}, trained on ${model.training_days} days.`} title="Forecast model">
      <div className="space-y-3">
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">
            <tr>
              <th className="py-1 text-left font-normal">Horizon</th>
              <th className="py-1 text-right font-normal">MAE</th>
              <th className="py-1 text-right font-normal">MAPE</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(model.holdout).map(([minutes, metrics]) => (
              <tr key={minutes} className="border-t border-white/5 tabular-nums">
                <td className="py-1.5 text-zinc-300">{minutes} min</td>
                <td className="py-1.5 text-right text-white">{kw(metrics.mae_kw, 2)}</td>
                <td className="py-1.5 text-right text-white">{pct(metrics.mape_pct, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm text-zinc-400">
          Holdout: last 30 days, scored before final training. Live 15-min error:{" "}
          <span className="text-white">{kw(model.live_mae_15_kw, 2)}</span>
        </p>
        <p className="text-xs text-zinc-500">
          Inputs: {model.features.join(", ")}. {model.data_note}.
        </p>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ meters

export function MeterGrid({ meters }: { meters: Meter[] }) {
  return (
    <Panel description="Validated reading for each house this interval, grouped by phase." title="Smart meters">
      <div className="grid gap-4 lg:grid-cols-3">
        {PHASES.map((phase) => (
          <div key={phase} className="space-y-2">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">{phase}</p>
            {meters
              .filter((meter) => meter.phase === phase)
              .map((meter) => (
                <div key={meter.house_id} className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="font-medium text-white">{meter.house_id}</span>
                      <span className="truncate text-zinc-400">{meter.label}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-white">{kw(meter.net_kw, 2)}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {meter.medical ? (
                      <Chip>
                        <HeartPulse aria-hidden className="size-3" /> Critical medical, protected
                      </Chip>
                    ) : null}
                    {!meter.enrolled && !meter.medical ? <Chip>Not enrolled</Chip> : null}
                    {meter.enrolled ? <Chip>Enrolled · accepts {pct(meter.accept_prob * 100)}</Chip> : null}
                    {meter.pv_kw > 0 ? (
                      <Chip>
                        <Sun aria-hidden className="size-3" /> {meter.generation_kw.toFixed(1)} kW solar
                      </Chip>
                    ) : null}
                    {meter.flag !== "ok" ? <Chip tone="warn">{FLAG_LABEL[meter.flag]}</Chip> : null}
                    {meter.shifted ? (
                      <Chip tone="good">
                        <Clock aria-hidden className="size-3" /> Load shifted
                      </Chip>
                    ) : null}
                    {meter.running.map((appliance) => (
                      <Chip key={appliance}>{appliance} on</Chip>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}
