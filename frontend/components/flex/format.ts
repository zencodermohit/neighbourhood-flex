import { CircleCheck, OctagonAlert, TriangleAlert } from "lucide-react";

import type { LoadClass, LoadStatus } from "@/components/flex/types";

// Dark-surface steps of the validated reference palette. Status colors are
// reserved for state and always ship with an icon and a label.
export const COLORS = {
  actual: "#3987e5",
  without: "#d95926",
  limit: "#a1a1aa",
  grid: "#ffffff14",
  axis: "#71717a",
  good: "#0ca30c",
  warning: "#fab219",
  critical: "#d03b3b",
};

// Ordinal blue ramp for protection classes: the most shiftable class is the most salient.
export const CLASS_META: Record<LoadClass, { label: string; color: string; note: string }> = {
  critical: { label: "Critical", color: "#184f95", note: "Never shifted" },
  essential: { label: "Essential", color: "#2a78d6", note: "Not shifted by default" },
  flexible: { label: "Flexible", color: "#6da7ec", note: "Movable within a window" },
  highly_deferrable: { label: "Highly deferrable", color: "#b7d3f6", note: "Pausable before a deadline" },
};

export const STATUS_META: Record<LoadStatus, { label: string; color: string; Icon: typeof CircleCheck }> = {
  normal: { label: "Within limit", color: COLORS.good, Icon: CircleCheck },
  near_limit: { label: "Near limit", color: COLORS.warning, Icon: TriangleAlert },
  overloaded: { label: "Over limit", color: COLORS.critical, Icon: OctagonAlert },
};

export function kw(value: number | null | undefined, digits = 1) {
  return value === null || value === undefined ? "–" : `${value.toFixed(digits)} kW`;
}

export function pct(value: number, digits = 0) {
  return `${value.toFixed(digits)}%`;
}

export function clock(iso: string) {
  return iso.slice(11, 16);
}

export function dayAndTime(iso: string) {
  const date = new Date(iso);
  return `${date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })} ${clock(iso)}`;
}
