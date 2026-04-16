"use client";

import type { StageName, StageRun } from "@/lib/types";
import { CHUNK_STAGE_ORDER, STAGE_ORDER, getStageRun } from "@/lib/types";
import { STAGE_SHORT_LABEL, STAGE_STATUS_LABEL } from "@/lib/stage-labels";

interface Props {
  stageRuns: StageRun[];
  onStageClick?: (stage: StageName) => void;
  compact?: boolean;
}

const GATE_STAGES = new Set<StageName>(["p1c", "p2c", "p2v", "p6v"]);

function stageColorClasses(sr: StageRun | undefined): string {
  if (!sr || sr.status === "pending") {
    return "bg-neutral-200 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400";
  }
  if (sr.status === "running") {
    return "bg-blue-500 text-white animate-pulse";
  }
  if (sr.status === "ok") {
    return "bg-emerald-500 text-white";
  }
  return "bg-red-500 text-white";
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildTitle(stage: StageName, sr: StageRun | undefined): string {
  const label = STAGE_SHORT_LABEL[stage];
  if (!sr) return `${label}：等待中`;
  const parts = [`${label}：${STAGE_STATUS_LABEL[sr.status]}`];
  if (sr.stale) parts.push("结果已过期");
  if (sr.attempt > 1) parts.push(`第 ${sr.attempt} 次尝试`);
  if (sr.durationMs != null) parts.push(formatDuration(sr.durationMs));
  if (sr.status === "failed" && sr.error) parts.push(sr.error);
  return parts.join(" · ");
}

export function StagePipeline({ stageRuns, onStageClick, compact = false }: Props) {
  const stages = compact ? CHUNK_STAGE_ORDER : STAGE_ORDER;
  const clickable = Boolean(onStageClick);

  return (
    <div className="inline-flex items-center">
      {stages.map((stage, index) => {
        const sr = getStageRun(stageRuns, stage);
        const gate = GATE_STAGES.has(stage);
        const previousStage = index > 0 ? stages[index - 1] : null;
        const previousGate = previousStage ? GATE_STAGES.has(previousStage) : false;
        const connectorWidth = gate || previousGate ? "w-1" : "w-2";

        return (
          <div key={stage} className="inline-flex items-center">
            {index > 0 ? (
              <span
                aria-hidden
                className={`inline-block h-px ${connectorWidth} bg-neutral-300 dark:bg-neutral-600`}
              />
            ) : null}
            <button
              type="button"
              title={buildTitle(stage, sr)}
              onClick={onStageClick ? () => onStageClick(stage) : undefined}
              disabled={!clickable}
              className={[
                "relative inline-flex items-center gap-1 transition",
                gate ? "rounded-sm px-1.5 py-0.5 text-[10px]" : compact ? "rounded-full px-2 py-0.5 text-[10px]" : "rounded-full px-2.5 py-1 text-xs",
                stageColorClasses(sr),
                clickable ? "cursor-pointer hover:brightness-110" : "cursor-default",
                sr?.stale ? "ring-2 ring-amber-500 ring-offset-1" : "",
              ].join(" ")}
            >
              <span className="font-semibold tracking-wide">{STAGE_SHORT_LABEL[stage]}</span>
              {sr?.status === "failed" ? <span className="leading-none">!</span> : null}
              {sr?.status === "running" ? (
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-white/90" />
              ) : null}
              {sr && sr.attempt > 1 ? (
                <sup className="absolute -top-1 -right-1 rounded-full bg-neutral-900 px-1 text-[9px] font-bold leading-tight text-white">
                  {sr.attempt}
                </sup>
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}
