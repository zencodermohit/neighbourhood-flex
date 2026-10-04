"use client";

import { useState } from "react";

import { COLORS, clock, kw } from "@/components/flex/format";
import type { ForecastHorizon, HistoryPoint } from "@/components/flex/types";

type Point = {
  time: string;
  actual: number | null;
  without: number | null;
  forecast: number | null;
  lower: number | null;
  upper: number | null;
  limit: number;
};

const SIZE = { width: 960, height: 300, top: 18, right: 24, bottom: 30, left: 46 };

function niceStep(range: number) {
  return [5, 10, 20, 25, 50, 100, 200, 500].find((step) => range / step <= 6) ?? 1000;
}

export function ForecastChart({
  history,
  horizons,
  limit,
}: {
  history: HistoryPoint[];
  horizons: ForecastHorizon[];
  limit: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const last = history[history.length - 1];
  const points: Point[] = [
    ...history.map((point, index) => ({
      time: point.time,
      actual: point.total_kw,
      without: point.without_kw,
      // The forecast line starts at "now" so it joins the actual line.
      forecast: index === history.length - 1 ? point.total_kw : null,
      lower: index === history.length - 1 ? point.total_kw : null,
      upper: index === history.length - 1 ? point.total_kw : null,
      limit: point.limit_kw,
    })),
    ...horizons.map((horizon) => ({
      time: horizon.time,
      actual: null,
      without: null,
      forecast: horizon.adjusted_kw,
      lower: horizon.lower_kw,
      upper: horizon.upper_kw,
      limit,
    })),
  ];
  const nowIndex = history.length - 1;

  const plotWidth = SIZE.width - SIZE.left - SIZE.right;
  const plotHeight = SIZE.height - SIZE.top - SIZE.bottom;
  const values = points.flatMap((p) => [p.actual, p.without, p.upper, p.limit]).filter((v): v is number => v !== null);
  const step = niceStep(Math.max(...values) * 1.1);
  const yMax = Math.ceil((Math.max(...values) * 1.05) / step) * step;
  const x = (index: number) => SIZE.left + (index / (points.length - 1)) * plotWidth;
  const y = (value: number) => SIZE.top + (1 - value / yMax) * plotHeight;
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, index) => index * step);

  function line(key: "actual" | "without" | "forecast") {
    let path = "";
    let pen = false;
    points.forEach((point, index) => {
      const value = point[key];
      if (value === null) {
        pen = false;
        return;
      }
      path += `${pen ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      pen = true;
    });
    return path;
  }

  const bandIndices = points.map((_, index) => index).filter((index) => points[index].upper !== null);
  const band =
    bandIndices.map((index, k) => `${k ? "L" : "M"}${x(index).toFixed(1)},${y(points[index].upper!).toFixed(1)}`).join("") +
    [...bandIndices].reverse().map((index) => `L${x(index).toFixed(1)},${y(points[index].lower!).toFixed(1)}`).join("") +
    "Z";

  // Shade the forecast gap: the part of the forecast above the limit.
  const gapSegments = horizons
    .map((horizon, k) => ({ index: nowIndex + 1 + k, value: horizon.adjusted_kw }))
    .filter((point) => point.value > limit);

  const hovered = hover === null ? null : points[hover];

  function handlePointer(event: React.PointerEvent<SVGRectElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-zinc-300">
        <Legend color={COLORS.actual} label="Transformer load (measured)" />
        <Legend color={COLORS.without} label="Without coordination" />
        <Legend color={COLORS.actual} dashed label="Forecast, next 60 min (80% band)" />
        <Legend color={COLORS.limit} dashed label={`Safe limit ${limit} kW`} />
      </div>
      <div className="relative">
        <svg
          aria-label={`Transformer load over the last ${history.length} intervals and the next hour's forecast against a ${limit} kW limit`}
          className="h-auto w-full"
          role="img"
          viewBox={`0 0 ${SIZE.width} ${SIZE.height}`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line stroke={COLORS.grid} x1={SIZE.left} x2={SIZE.left + plotWidth} y1={y(tick)} y2={y(tick)} />
              <text fill={COLORS.axis} fontSize="11" textAnchor="end" x={SIZE.left - 8} y={y(tick) + 4}>
                {tick}
              </text>
            </g>
          ))}
          <text fill={COLORS.axis} fontSize="11" x={6} y={SIZE.top - 6}>
            kW
          </text>
          {points.map((point, index) =>
            index % 12 === 0 ? (
              <text key={point.time} fill={COLORS.axis} fontSize="11" textAnchor="middle" x={x(index)} y={SIZE.height - 8}>
                {clock(point.time)}
              </text>
            ) : null,
          )}

          <rect
            fill="#ffffff08"
            height={plotHeight}
            width={x(points.length - 1) - x(nowIndex)}
            x={x(nowIndex)}
            y={SIZE.top}
          />
          <line stroke="#ffffff40" x1={x(nowIndex)} x2={x(nowIndex)} y1={SIZE.top} y2={SIZE.top + plotHeight} />
          <text fill="#d4d4d8" fontSize="11" textAnchor="end" x={x(nowIndex) - 6} y={SIZE.top + 12}>
            now {clock(last.time)}
          </text>

          <path d={band} fill={COLORS.actual} fillOpacity="0.18" stroke="none" />
          {gapSegments.map((point) => (
            <rect
              key={point.index}
              fill={COLORS.critical}
              fillOpacity="0.28"
              height={y(limit) - y(point.value)}
              width={Math.max(plotWidth / (points.length - 1) - 2, 2)}
              x={x(point.index) - plotWidth / (points.length - 1) / 2 + 1}
              y={y(point.value)}
            />
          ))}

          <line
            stroke={COLORS.limit}
            strokeDasharray="6 4"
            strokeWidth="1.5"
            x1={SIZE.left}
            x2={SIZE.left + plotWidth}
            y1={y(limit)}
            y2={y(limit)}
          />
          <path d={line("without")} fill="none" stroke={COLORS.without} strokeLinejoin="round" strokeWidth="2" />
          <path d={line("actual")} fill="none" stroke={COLORS.actual} strokeLinejoin="round" strokeWidth="2" />
          <path
            d={line("forecast")}
            fill="none"
            stroke={COLORS.actual}
            strokeDasharray="5 4"
            strokeLinejoin="round"
            strokeWidth="2"
          />

          {hovered && hover !== null ? (
            <g pointerEvents="none">
              <line stroke="#ffffff40" x1={x(hover)} x2={x(hover)} y1={SIZE.top} y2={SIZE.top + plotHeight} />
              {hovered.without !== null ? (
                <circle cx={x(hover)} cy={y(hovered.without)} fill={COLORS.without} r="4.5" stroke="#000" strokeWidth="2" />
              ) : null}
              {(hovered.actual ?? hovered.forecast) !== null ? (
                <circle
                  cx={x(hover)}
                  cy={y((hovered.actual ?? hovered.forecast)!)}
                  fill={COLORS.actual}
                  r="4.5"
                  stroke="#000"
                  strokeWidth="2"
                />
              ) : null}
            </g>
          ) : null}
          <rect
            fill="transparent"
            height={plotHeight}
            onPointerLeave={() => setHover(null)}
            onPointerMove={handlePointer}
            width={plotWidth}
            x={SIZE.left}
            y={SIZE.top}
          />
        </svg>

        {hovered && hover !== null ? (
          <div
            className="pointer-events-none absolute top-2 z-10 w-60 rounded-xl border border-white/10 bg-zinc-950/95 p-3 text-xs text-zinc-300 shadow-lg"
            style={{
              left: `${(x(hover) / SIZE.width) * 100}%`,
              transform: hover > points.length / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
            }}
          >
            <p className="font-medium text-white">
              {clock(hovered.time)} {hover > nowIndex ? "· forecast" : ""}
            </p>
            {hovered.actual !== null ? <Row color={COLORS.actual} label="Measured" value={kw(hovered.actual)} /> : null}
            {hovered.without !== null ? (
              <Row color={COLORS.without} label="Without coordination" value={kw(hovered.without)} />
            ) : null}
            {hover > nowIndex && hovered.forecast !== null ? (
              <>
                <Row color={COLORS.actual} label="Forecast" value={kw(hovered.forecast)} />
                <Row label="80% range" value={`${hovered.lower!.toFixed(1)}–${hovered.upper!.toFixed(1)} kW`} />
              </>
            ) : null}
            <Row label="Safe limit" value={kw(hovered.limit)} />
          </div>
        ) : null}
      </div>

      <details className="text-sm text-zinc-400">
        <summary className="cursor-pointer select-none text-zinc-300">Show as table</summary>
        <div className="mt-3 max-h-64 overflow-auto rounded-xl border border-white/10">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-zinc-950 text-xs uppercase tracking-[0.14em] text-zinc-500">
              <tr>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2 text-right">Measured</th>
                <th className="px-3 py-2 text-right">Without</th>
                <th className="px-3 py-2 text-right">Forecast</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((point) => (
                <tr key={point.time} className="border-t border-white/5">
                  <td className="px-3 py-1.5">{clock(point.time)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{kw(point.actual)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{kw(point.without)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {point.actual === null ? kw(point.forecast) : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg aria-hidden height="2" width="20">
        <line stroke={color} strokeDasharray={dashed ? "5 3" : undefined} strokeWidth="2" x1="0" x2="20" y1="1" y2="1" />
      </svg>
      {label}
    </span>
  );
}

function Row({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="mt-1.5 flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-2">
        {color ? <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: color }} /> : null}
        {label}
      </span>
      <span className="tabular-nums text-white">{value}</span>
    </div>
  );
}
