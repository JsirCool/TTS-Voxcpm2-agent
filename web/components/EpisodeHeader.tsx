"use client";

import type { Episode, EpisodeStatus } from "@/lib/types";

interface Props {
  episode: Episode;
  running: boolean;
  currentStage: string | null;
  onRun: () => void;
  onExport: () => void;
}

const STATUS_BADGE: Record<
  EpisodeStatus,
  { bg: string; fg: string; br: string; label: string }
> = {
  done: {
    bg: "bg-emerald-50",
    fg: "text-emerald-700",
    br: "border-emerald-200",
    label: "✓ done",
  },
  running: {
    bg: "bg-blue-50",
    fg: "text-blue-700",
    br: "border-blue-200",
    label: "⏵ running",
  },
  ready: {
    bg: "bg-neutral-50",
    fg: "text-neutral-600",
    br: "border-neutral-200",
    label: "ready",
  },
  failed: {
    bg: "bg-red-50",
    fg: "text-red-700",
    br: "border-red-200",
    label: "✗ failed",
  },
  empty: {
    bg: "bg-neutral-50",
    fg: "text-neutral-500",
    br: "border-neutral-200",
    label: "empty",
  },
};

export function EpisodeHeader({
  episode,
  running,
  currentStage,
  onRun,
  onExport,
}: Props) {
  const badge = STATUS_BADGE[episode.status] ?? STATUS_BADGE.ready;
  const runDisabled = running;
  const exportDisabled = episode.status !== "done";

  return (
    <div className="px-6 py-3 border-b border-neutral-200 bg-white shrink-0">
      <div className="flex items-center gap-3 mb-2">
        <h2 className="text-lg font-semibold">{episode.id}</h2>
        <span
          className={`text-xs px-2 py-0.5 rounded-full border ${badge.bg} ${badge.fg} ${badge.br}`}
        >
          {badge.label}
        </span>
        {currentStage ? (
          <span className="text-xs text-neutral-500 font-mono">
            {currentStage}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-neutral-400 font-mono">
          {episode.chunks.length} chunks · {episode.totalDurationS.toFixed(1)}s
        </span>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onRun}
          disabled={runDisabled}
          className={`px-3 py-1.5 text-sm bg-neutral-900 text-white rounded hover:bg-neutral-800 ${
            runDisabled ? "opacity-50 cursor-not-allowed" : ""
          }`}
        >
          ▶ Run
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={exportDisabled}
          className={`px-3 py-1.5 text-sm bg-white border border-neutral-300 rounded hover:bg-neutral-50 ${
            exportDisabled ? "opacity-50 cursor-not-allowed" : ""
          }`}
        >
          ⤓ Export
        </button>
      </div>
    </div>
  );
}
