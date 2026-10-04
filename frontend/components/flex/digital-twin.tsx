"use client";

import { useEffect, useRef, useState } from "react";
import { Box, HeartPulse, MousePointerClick, ScanSearch, StepForward, Sun, X } from "lucide-react";

import { COLORS, STATUS_META, clock, kw, pct } from "@/components/flex/format";
import { estimateThermal } from "@/components/flex/thermal";
import type { FlexState } from "@/components/flex/types";
import type { ModelSource, TwinScene, TwinTarget } from "@/components/flex/twin/scene";
import { Button } from "@/components/ui/button";

const MODEL_CREDIT_URL = "https://sketchfab.com/3d-models/high-voltage-power-transformer-727bc7bb6777467dbea2ab6e0590bf4a";

export function DigitalTwin({
  state,
  onStep,
  onShowActions,
  busy,
}: {
  state: FlexState;
  onStep: () => void;
  onShowActions: () => void;
  busy: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<TwinScene | null>(null);
  const latestState = useRef(state);
  const [selected, setSelected] = useState<TwinTarget>(null);
  const [hovered, setHovered] = useState<TwinTarget>(null);
  const [source, setSource] = useState<ModelSource>("loading");
  const [webglError, setWebglError] = useState(false);

  useEffect(() => {
    latestState.current = state;
    sceneRef.current?.update(state);
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    let instance: TwinScene | null = null;
    // three.js is loaded only in the browser.
    import("@/components/flex/twin/scene")
      .then(({ TwinScene }) => {
        if (cancelled || !containerRef.current) return;
        try {
          instance = new TwinScene(containerRef.current, {
            onDoubleClick: setSelected,
            onHover: setHovered,
            onModelSource: setSource,
          });
        } catch {
          setWebglError(true);
          return;
        }
        sceneRef.current = instance;
        instance.update(latestState.current);
      })
      .catch(() => setWebglError(true));
    return () => {
      cancelled = true;
      instance?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelected(null);
        sceneRef.current?.focus(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function close() {
    setSelected(null);
    sceneRef.current?.focus(null);
  }

  function inspectTransformer() {
    setSelected({ kind: "transformer" });
    sceneRef.current?.focus({ kind: "transformer" });
  }

  const { transformer, config } = state;
  const thermal = estimateThermal(transformer.apparent_kva, config.transformer_rating_kva, state.weather.temperature_c);
  const status = STATUS_META[transformer.status];
  const hoveredMeter = hovered?.kind === "house" ? state.meters.find((meter) => meter.house_id === hovered.id) : null;
  const selectedMeter = selected?.kind === "house" ? state.meters.find((meter) => meter.house_id === selected.id) : null;

  return (
    <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(ellipse_at_top,#1a2433_0%,#07090c_55%,#030405_100%)]">
      <div ref={containerRef} className="relative h-[460px] w-full md:h-[560px]" />

      {webglError ? (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-zinc-400">
          3D view unavailable: this browser could not start WebGL.
        </div>
      ) : null}

      {/* Heads-up display */}
      <div className="pointer-events-none absolute left-4 top-4 space-y-2 md:left-6 md:top-6">
        <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-400">Digital twin · DT-07</p>
        <div className="flex items-baseline gap-3">
          <span className="text-4xl font-semibold tabular-nums text-white md:text-5xl">{transformer.total_kw.toFixed(1)}</span>
          <span className="text-sm text-zinc-400">kW of {config.safe_limit_kw} kW</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-white">
            <status.Icon aria-hidden className="size-3.5" style={{ color: status.color }} />
            {status.label}
          </span>
          <span className="rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-zinc-300">
            hot spot ~{thermal.hotSpotC.toFixed(0)}°C
          </span>
          <span className="rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-zinc-300">
            {clock(state.clock.time)} · {state.weather.temperature_c}°C outside
          </span>
        </div>
      </div>

      <div className="absolute right-4 top-4 md:right-6 md:top-6">
        {selected?.kind !== "transformer" ? (
          <Button onClick={inspectTransformer} size="sm" type="button" variant="outline">
            <ScanSearch aria-hidden className="mr-2 size-4" /> Inspect transformer
          </Button>
        ) : null}
      </div>

      {/* Hover hint */}
      {hovered && !selected ? (
        <div className="pointer-events-none absolute bottom-14 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-black/80 px-3 py-1.5 text-xs text-white">
          {hovered.kind === "transformer"
            ? "Distribution transformer DT-07 · double-click to inspect"
            : hoveredMeter
              ? `${hoveredMeter.house_id} · ${hoveredMeter.label} · ${kw(hoveredMeter.net_kw, 2)} on ${hoveredMeter.phase} · double-click for meter`
              : ""}
        </div>
      ) : null}

      <div className="pointer-events-none absolute bottom-4 left-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400 md:left-6">
        <span className="inline-flex items-center gap-1.5">
          <MousePointerClick aria-hidden className="size-3.5" /> Double-click the transformer or a house · drag to orbit · Esc to reset
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-3 rounded-sm" style={{ backgroundColor: COLORS.actual }} /> house import
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-3 rounded-sm bg-[#199e70]" /> solar export
        </span>
      </div>

      <div className="absolute bottom-4 right-4 max-w-[60%] text-right text-[11px] text-zinc-500 md:right-6">
        {source === "sketchfab" ? (
          <>
            Model:{" "}
            <a className="underline hover:text-zinc-300" href={MODEL_CREDIT_URL} rel="noreferrer" target="_blank">
              High voltage power transformer
            </a>{" "}
            by Showdoze, CC BY-NC 4.0
          </>
        ) : source === "procedural" ? (
          <span className="inline-flex items-center gap-1.5">
            <Box aria-hidden className="size-3" /> Built-in model · add <code>public/models/transformer.glb</code> for the Sketchfab model
          </span>
        ) : (
          "Loading model…"
        )}
      </div>

      {/* Transformer inspection */}
      {selected?.kind === "transformer" ? (
        <aside className="absolute inset-y-3 right-3 flex w-[min(380px,calc(100%-24px))] flex-col gap-3 overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950/92 p-5 shadow-2xl backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Inspection</p>
              <h3 className="mt-1 text-lg font-semibold text-white">DT-07 · {config.transformer_rating_kva} kVA</h3>
              <p className="text-xs text-zinc-500">11 / 0.433 kV · ONAN · {clock(state.clock.time)}</p>
            </div>
            <button aria-label="Close inspection" className="rounded-lg p-1 text-zinc-400 hover:bg-white/10 hover:text-white" onClick={close} type="button">
              <X className="size-5" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Tile label="Load" sub={`${pct(transformer.loading_pct)} of safe limit`} value={kw(transformer.total_kw)} />
            <Tile label="Apparent power" sub={`${pct(transformer.rating_pct)} of rating`} value={`${transformer.apparent_kva.toFixed(1)} kVA`} />
            <Tile
              accent={STATUS_META[thermal.status].color}
              label="Hot-spot (est.)"
              sub={`top oil ~${thermal.topOilC.toFixed(0)}°C`}
              value={`${thermal.hotSpotC.toFixed(0)}°C`}
            />
            <Tile
              accent={STATUS_META[thermal.status].color}
              label="Insulation ageing"
              sub={thermal.ageingFactor >= 1 ? "faster than normal" : "slower than normal"}
              value={`${thermal.ageingFactor.toFixed(2)}×`}
            />
          </div>

          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Phases</p>
            {transformer.phases.map((phase) => (
              <div key={phase.phase} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-white">{phase.phase}</span>
                  <span className="tabular-nums text-zinc-300">
                    {kw(phase.kw)} · {phase.current_a.toFixed(0)} A · {phase.voltage_v.toFixed(0)} V
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(phase.loading_pct, 100)}%`,
                      backgroundColor: phase.status === "normal" ? COLORS.actual : STATUS_META[phase.status].color,
                    }}
                  />
                </div>
              </div>
            ))}
            <p className="text-xs text-zinc-500">Imbalance {pct(transformer.imbalance_pct)} · evening-peak imbalance {pct(state.phase_balance.peak_window_imbalance_pct)}</p>
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Next {config.horizon_minutes} minutes</p>
            {state.forecast.horizons.map((horizon) => (
              <div key={horizon.minutes} className="flex justify-between text-sm tabular-nums">
                <span className="text-zinc-400">{clock(horizon.time)}</span>
                <span className="text-white">
                  {kw(horizon.adjusted_kw)}
                  {horizon.gap_kw > 0 ? <span style={{ color: COLORS.critical }}> · gap {kw(horizon.gap_kw)}</span> : null}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <Button disabled={busy || state.clock.running} onClick={onStep} size="sm" type="button" variant="outline">
              <StepForward aria-hidden className="mr-1.5 size-4" /> Step 15 min
            </Button>
            <Button onClick={onShowActions} size="sm" type="button">
              Action queue ({state.actions.filter((action) => action.status === "pending_approval").length} pending)
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Hot-spot and ageing are steady-state estimates after IEEE C57.91 (ONAN, 65 °C rise) from present load and ambient
            temperature, not measurements. Ageing 1.0× = normal life at 110 °C.
          </p>
        </aside>
      ) : null}

      {/* House meter card */}
      {selectedMeter ? (
        <aside className="absolute right-3 top-3 w-[min(320px,calc(100%-24px))] space-y-3 rounded-2xl border border-white/10 bg-zinc-950/92 p-4 shadow-2xl backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Smart meter · {selectedMeter.phase}</p>
              <h3 className="mt-1 font-semibold text-white">
                {selectedMeter.house_id} · {selectedMeter.label}
              </h3>
            </div>
            <button aria-label="Close meter" className="rounded-lg p-1 text-zinc-400 hover:bg-white/10 hover:text-white" onClick={close} type="button">
              <X className="size-5" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Tile label="Import" value={kw(selectedMeter.consumption_kw, 2)} />
            <Tile label="Solar" value={kw(selectedMeter.generation_kw, 2)} />
            <Tile label="Net" value={kw(selectedMeter.net_kw, 2)} />
          </div>
          <ul className="space-y-1 text-sm text-zinc-300">
            <li>Reading: {selectedMeter.flag === "ok" ? "valid" : selectedMeter.flag.replace("_", " ")}</li>
            <li>
              Programme:{" "}
              {selectedMeter.medical ? (
                <span className="inline-flex items-center gap-1">
                  <HeartPulse aria-hidden className="size-3.5" /> critical medical load, never asked
                </span>
              ) : selectedMeter.enrolled ? (
                `enrolled, accepts ~${pct(selectedMeter.accept_prob * 100)} of requests`
              ) : (
                "not enrolled"
              )}
            </li>
            {selectedMeter.pv_kw > 0 ? (
              <li className="inline-flex items-center gap-1">
                <Sun aria-hidden className="size-3.5" /> {selectedMeter.pv_kw} kW rooftop solar
              </li>
            ) : null}
            <li>Running now: {selectedMeter.running.length ? selectedMeter.running.join(", ") : "base load only"}</li>
            {selectedMeter.shifted ? <li style={{ color: COLORS.good }}>Has load shifted out of the peak</li> : null}
          </ul>
        </aside>
      ) : null}
    </section>
  );
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/50 p-3">
      <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{label}</p>
      <p className="mt-1.5 flex items-center gap-1.5 text-base font-semibold tabular-nums text-white">
        {accent ? <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: accent }} /> : null}
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-[11px] text-zinc-400">{sub}</p> : null}
    </div>
  );
}
