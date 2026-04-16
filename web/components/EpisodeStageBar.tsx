"use client";

import type { Chunk, StageName } from "@/lib/types";
import { STAGE_SHORT_LABEL } from "@/lib/stage-labels";

interface Props {
  chunks: Chunk[];
  onStageRetry?: (stage: StageName) => void;
}

const CHUNK_STAGES: StageName[] = ["p2", "p2c", "p2v", "p5"];
const GATE_STAGES = new Set<StageName>(["p1c", "p2c", "p2v", "p6v"]);

interface StageAgg {
  total: number;
  ok: number;
  failed: number;
  running: number;
  pending: number;
}

function aggregate(chunks: Chunk[], stage: StageName): StageAgg {
  const agg: StageAgg = { total: chunks.length, ok: 0, failed: 0, running: 0, pending: 0 };
  for (const chunk of chunks) {
    const sr = chunk.stageRuns.find((run) => run.stage === stage);
    if (!sr || sr.status === "pending") agg.pending += 1;
    else if (sr.status === "ok") agg.ok += 1;
    else if (sr.status === "failed") agg.failed += 1;
    else if (sr.status === "running") agg.running += 1;
  }
  return agg;
}

function pillColor(agg: StageAgg): string {
  if (agg.running > 0) return "bg-blue-500 text-white animate-pulse";
  if (agg.failed > 0) return "bg-red-100 text-red-700 border border-red-300";
  if (agg.ok === agg.total && agg.total > 0) return "bg-emerald-500 text-white";
  if (agg.ok > 0) return "bg-emerald-100 text-emerald-700 border border-emerald-300";
  return "bg-neutral-200 text-neutral-500";
}

function pillLabel(stage: StageName, agg: StageAgg): string {
  const label = STAGE_SHORT_LABEL[stage];
  if (agg.running > 0) return `${label}…`;
  if (agg.failed > 0) return `${label} ${agg.failed}`;
  if (agg.ok === agg.total && agg.total > 0) return `${label} 完成`;
  if (agg.ok > 0) return `${label} ${agg.ok}/${agg.total}`;
  return label;
}

export function EpisodeStageBar({ chunks, onStageRetry }: Props) {
  if (chunks.length === 0) return null;

  return (
    <div className="px-6 py-1.5 border-b border-neutral-100 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 flex items-center gap-1 shrink-0">
      <span className="text-[10px] text-neutral-400 dark:text-neutral-500 mr-2 uppercase tracking-wide">
        阶段总览
      </span>
      {CHUNK_STAGES.map((stage, index) => {
        const agg = aggregate(chunks, stage);
        const clickable = agg.failed > 0 && Boolean(onStageRetry);
        return (
          <div key={stage} className="inline-flex items-center">
            {index > 0 ? <span className="inline-block w-3 h-px bg-neutral-300 dark:bg-neutral-600 mx-0.5" /> : null}
            <button
              type="button"
              disabled={!clickable}
              onClick={clickable ? () => onStageRetry?.(stage) : undefined}
              title={agg.failed > 0 ? `${agg.failed} 个 chunk 失败，点击批量重跑` : `${agg.ok}/${agg.total} 已完成`}
              className={`inline-flex items-center px-2 py-0.5 ${
                GATE_STAGES.has(stage) ? "rounded-sm text-[9px]" : "rounded-full text-[10px]"
              } font-semibold ${pillColor(agg)} ${clickable ? "cursor-pointer hover:brightness-110" : "cursor-default"}`}
            >
              {pillLabel(stage, agg)}
            </button>
          </div>
        );
      })}
    </div>
  );
}
