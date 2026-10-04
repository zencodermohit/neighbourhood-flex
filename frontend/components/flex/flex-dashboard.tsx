"use client";

import { useEffect, useState } from "react";
import { Pause, Play, RotateCcw, StepForward, Thermometer } from "lucide-react";

import { DigitalTwin } from "@/components/flex/digital-twin";
import { ForecastChart } from "@/components/flex/forecast-chart";
import { kw, pct } from "@/components/flex/format";
import {
  ActionQueue,
  DataQualityPanel,
  EscalationPanel,
  FlowStrip,
  GapPanel,
  LoadClassPanel,
  MeterGrid,
  ModelPanel,
  Panel,
  PhasePanel,
  Stat,
  TransformerPanel,
  VerificationPanel,
} from "@/components/flex/panels";
import type { FlexState } from "@/components/flex/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BACKEND_URL, streamUrl } from "@/lib/config";

async function post(path: string, body?: unknown): Promise<FlexState> {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message ?? "Request failed.");
  }
  return payload.data as FlexState;
}

export function FlexDashboard() {
  const [state, setState] = useState<FlexState | null>(null);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [limitDraft, setLimitDraft] = useState("");

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;

    // First paint over REST so the page renders even before the stream connects.
    fetch(`${BACKEND_URL}/api/state`)
      .then((response) => response.json())
      .then((payload) => {
        if (!closed && payload?.data) {
          setState((current) => current ?? (payload.data as FlexState));
        }
      })
      .catch(() => setConnection("offline"));

    const connect = () => {
      setConnection("connecting");
      socket = new WebSocket(streamUrl());
      socket.onopen = () => setConnection("live");
      socket.onmessage = (event) => {
        const incoming = JSON.parse(event.data) as { type: string; payload: FlexState };
        if (incoming.type === "SNAPSHOT") {
          setState(incoming.payload);
        }
      };
      socket.onclose = () => {
        setConnection("offline");
        if (!closed) {
          retry = window.setTimeout(connect, 2000);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  async function run(path: string, body?: unknown, success?: string) {
    setBusy(true);
    try {
      setState(await post(path, body));
      setMessage(success ?? "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black p-6 text-center text-zinc-400">
        {connection === "offline"
          ? `Cannot reach the engine at ${BACKEND_URL || "this server"}. Start the backend, this page reconnects automatically.`
          : "Connecting to the Neighbourhood Flex engine…"}
      </div>
    );
  }

  const { clock: simClock, config, totals } = state;
  const time = new Date(simClock.time);

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-6 md:px-8">
        <header className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.02))] p-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>Neighbourhood Flex</Badge>
              <Badge>{connection === "live" ? "Live" : connection === "offline" ? "Reconnecting" : "Connecting"}</Badge>
              {simClock.in_peak_window ? <Badge>Evening peak window</Badge> : null}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Transformer-level flexibility coordination</h1>
            <p className="text-sm text-zinc-400">
              {time.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })} ·{" "}
              <span className="tabular-nums text-white">{simClock.time.slice(11, 16)}</span> · {state.weather.temperature_c}°C ·
              cloud {state.weather.cloud_pct}% · one tick = {simClock.interval_minutes} min
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {simClock.running ? (
              <Button disabled={busy} onClick={() => void run("/api/simulation/pause")} type="button">
                <Pause aria-hidden className="mr-2 size-4" /> Pause
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void run("/api/simulation/start")} type="button">
                <Play aria-hidden className="mr-2 size-4" /> Run
              </Button>
            )}
            <Button disabled={busy || simClock.running} onClick={() => void run("/api/simulation/step")} type="button" variant="outline">
              <StepForward aria-hidden className="mr-2 size-4" /> Step 15 min
            </Button>
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              Speed
              <select
                className="h-11 rounded-xl border border-white/15 bg-black px-3 text-white"
                onChange={(event) => void run("/api/simulation/speed", { seconds_per_interval: Number(event.target.value) })}
                value={simClock.seconds_per_interval}
              >
                {[0.5, 1, 2, 4].map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds}s / tick
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              <Thermometer aria-hidden className="size-4" />
              <select
                aria-label="Heatwave scenario"
                className="h-11 rounded-xl border border-white/15 bg-black px-3 text-white"
                onChange={(event) =>
                  void run("/api/config", { temperature_offset_c: Number(event.target.value) }, "Temperature scenario updated.")
                }
                value={config.temperature_offset_c}
              >
                {[0, 2, 4, 6].map((offset) => (
                  <option key={offset} value={offset}>
                    {offset === 0 ? "Normal weather" : `Heatwave +${offset}°C`}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={busy}
              onClick={() => void run("/api/simulation/reset", undefined, "Simulation reset to its start.")}
              type="button"
              variant="ghost"
            >
              <RotateCcw aria-hidden className="mr-2 size-4" /> Reset
            </Button>
          </div>
        </header>

        {message ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-zinc-300">{message}</div>
        ) : null}

        <DigitalTwin
          busy={busy}
          onShowActions={() => document.getElementById("action-queue")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          onStep={() => void run("/api/simulation/step")}
          state={state}
        />

        <FlowStrip state={state} />

        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Stat
            label="Over-limit intervals"
            sub={`would be ${totals.intervals_over_limit_without} without coordination`}
            value={`${totals.intervals_over_limit} of ${totals.intervals}`}
          />
          <Stat
            label="Household requests"
            sub={`${totals.requests_accepted} accepted · ${totals.requests_declined} declined`}
            value={`${totals.requests_sent}`}
          />
          <Stat label="Energy moved off-peak" value={`${totals.energy_shifted_kwh.toFixed(1)} kWh`} />
          <Stat label="Escalations to DISCOM" value={`${totals.escalations}`} />
          <Stat label="Meter readings repaired" value={`${totals.meter_issues}`} />
          <Stat
            label="Avg demand per house"
            sub="aggregate is the operating signal"
            value={kw(state.demand.avg_per_house_kw, 2)}
          />
        </div>

        <div className="grid gap-5 xl:grid-cols-3">
          <TransformerPanel state={state} />
          <PhasePanel state={state} />
          <GapPanel state={state} />
        </div>

        <Panel
          aside={
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = Number(limitDraft);
                if (value > 0) {
                  void run("/api/config", { safe_limit_kw: value }, `Safe limit set to ${value} kW.`);
                  setLimitDraft("");
                }
              }}
            >
              <input
                aria-label="Safe operating limit in kW"
                className="h-9 w-28 rounded-lg border border-white/15 bg-black px-3 text-sm text-white placeholder:text-zinc-500"
                inputMode="decimal"
                min="1"
                onChange={(event) => setLimitDraft(event.target.value)}
                placeholder={`${config.safe_limit_kw} kW`}
                type="number"
                value={limitDraft}
              />
              <Button disabled={busy || !limitDraft} size="sm" type="submit" variant="outline">
                Set limit
              </Button>
            </form>
          }
          description={`Measured transformer load for the last 24 hours, and the forecast for the next ${config.horizon_minutes} minutes after flexibility already dispatched. Red shading marks the forecast gap.`}
          title="Load, forecast and safe limit"
        >
          <ForecastChart history={state.history} horizons={state.forecast.horizons} limit={config.safe_limit_kw} />
        </Panel>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="scroll-mt-6 space-y-3" id="action-queue">
            <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300">
              <input
                checked={config.auto_dispatch}
                className="size-4 accent-white"
                onChange={(event) =>
                  void run(
                    "/api/config",
                    { auto_dispatch: event.target.checked },
                    event.target.checked ? "Household requests are sent automatically." : "Household requests now need approval.",
                  )
                }
                type="checkbox"
              />
              Auto-send household time-shift requests (standing utility policy). Phase changes always need approval.
            </label>
            <ActionQueue
              actions={state.actions}
              autoDispatch={config.auto_dispatch}
              busy={busy}
              onApprove={(id) => void run(`/api/actions/${id}/approve`, undefined, `${id} approved.`)}
              onReject={(id) => void run(`/api/actions/${id}/reject`, undefined, `${id} rejected.`)}
            />
          </div>
          <div className="space-y-5">
            <VerificationPanel actions={state.actions} />
            <EscalationPanel
              busy={busy}
              escalations={state.escalations}
              onAcknowledge={(id) => void run(`/api/escalations/${id}/acknowledge`, undefined, `${id} acknowledged.`)}
            />
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-3">
          <LoadClassPanel state={state} />
          <DataQualityPanel state={state} />
          <ModelPanel state={state} />
        </div>

        <MeterGrid meters={state.meters} />

        <p className="pb-4 text-center text-xs text-zinc-600">
          Simulated neighbourhood: synthetic meters, weather and history. Imbalance now {pct(state.transformer.imbalance_pct)} ·
          transformer {state.transformer.apparent_kva.toFixed(1)} kVA of {config.transformer_rating_kva} kVA.
        </p>
      </div>
    </div>
  );
}
