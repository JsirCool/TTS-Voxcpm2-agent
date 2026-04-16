"use client";

import type { AttemptRecord, StageName } from "@/lib/types";
import { STAGE_SHORT_LABEL } from "@/lib/stage-labels";

interface Props {
  attempt: AttemptRecord;
  attemptIndex: number;
  isCurrent: boolean;
  isRunning?: boolean;
  onPlay?: () => void;
  onUse?: () => void;
  onStageClick?: (stage: StageName) => void;
}

const RETRY_STAGES: StageName[] = ["p2", "p2c", "p2v"];

function pillColor(stage: StageName, verdict: "pass" | "fail", isRunning: boolean): string {
  if (stage === "p2v") {
    if (isRunning) return "bg-blue-500 text-white animate-pulse";
    return verdict === "pass" ? "bg-emerald-500 text-white" : "bg-red-500 text-white";
  }
  return "bg-neutral-300 text-neutral-600";
}

function diagnosisSummary(attempt: AttemptRecord): string | null {
  const diagnosis = attempt.diagnosis;
  if (!diagnosis) return null;
  const parts: string[] = [];
  if (diagnosis.type) parts.push(diagnosis.type);
  if (diagnosis.detail) parts.push(diagnosis.detail);
  return parts.length > 0 ? parts.join(" | ") : null;
}

function repairAction(attempt: AttemptRecord): string | null {
  if (attempt.verdict === "pass") return null;
  if (attempt.level >= 2) return "转人工复核";
  if (attempt.diagnosis?.type === "speed_anomaly") return "建议改稿后重跑";
  if (attempt.diagnosis?.type === "silence_anomaly") return "建议先排查静音";
  return `继续自动修复到 L${attempt.level + 1}`;
}

export function RetryRow({
  attempt,
  attemptIndex,
  isCurrent,
  isRunning = false,
  onPlay,
  onUse,
  onStageClick,
}: Props) {
  const durationS = (attempt.durationMs / 1000).toFixed(1);
  const diagnosis = diagnosisSummary(attempt);
  const repair = repairAction(attempt);
  const rowBg = isRunning
    ? "bg-[#f5f9ff]"
    : isCurrent && attempt.verdict === "pass"
      ? "bg-[#f0fdf4]"
      : "bg-[#fcfcfc]";

  return (
    <div className={`flex items-center gap-2 px-2 py-1 text-[11px] border-b border-neutral-100 dark:border-neutral-700 ${rowBg}`}>
      <div className="flex items-center gap-1 w-[172px] shrink-0">
        <span className="font-mono text-neutral-400">#{attemptIndex}</span>
        <span className="font-mono text-neutral-400">L{attempt.level}</span>
        <span className="flex-1 border-b border-dashed border-neutral-300 dark:border-neutral-600" />
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        {RETRY_STAGES.map((stage) => (
          <button
            key={stage}
            type="button"
            onClick={onStageClick ? () => onStageClick(stage) : undefined}
            disabled={!onStageClick}
            className={[
              "inline-flex items-center justify-center rounded-sm h-4 px-1.5 text-[8px] font-semibold",
              pillColor(stage, attempt.verdict, isRunning),
              onStageClick ? "cursor-pointer hover:brightness-110" : "cursor-default",
            ].join(" ")}
          >
            {STAGE_SHORT_LABEL[stage]}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <span className="font-mono text-neutral-500">第 {attemptIndex} 次 take</span>
        <span className="font-mono text-neutral-400">{durationS}s</span>
        <button
          type="button"
          onClick={onPlay}
          className="px-1 py-0.5 rounded hover:bg-neutral-200 text-neutral-600 text-[10px]"
          title="试听"
        >
          ▶
        </button>
        {isCurrent ? (
          <span className="text-emerald-600 text-[10px] font-medium">已采用</span>
        ) : (
          <button
            type="button"
            onClick={onUse}
            className="px-1.5 py-0.5 rounded bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200 text-[10px]"
          >
            使用
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        <span className={`font-mono font-bold text-[10px] ${attempt.verdict === "pass" ? "text-emerald-600" : "text-red-600"}`}>
          {attempt.verdict === "pass" ? "通过" : "失败"}
        </span>
        <span className="font-mono text-neutral-500 text-[10px]">{attempt.scores.weightedScore.toFixed(2)}</span>
        {diagnosis ? (
          <span className="text-neutral-400 text-[10px] truncate" title={diagnosis}>
            {diagnosis}
          </span>
        ) : null}
        {repair ? <span className="text-amber-600 text-[10px] font-medium shrink-0">→ {repair}</span> : null}
      </div>
    </div>
  );
}
