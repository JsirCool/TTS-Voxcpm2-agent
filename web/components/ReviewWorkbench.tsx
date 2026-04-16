"use client";

import type { Chunk, StageName } from "@/lib/types";
import type { ChunkFilterMode } from "./ChunksTable";
import { STAGE_SHORT_LABEL } from "@/lib/stage-labels";

interface Props {
  chunks: Chunk[];
  stagedChunkCount: number;
  filterMode: ChunkFilterMode;
  onFilterModeChange: (mode: ChunkFilterMode) => void;
  onBatchRetry: (stage: StageName, chunkIds: string[]) => void | Promise<void>;
  onApplyStaged: () => void | Promise<void>;
}

function isProblemChunk(chunk: Chunk): boolean {
  return (
    chunk.status === "needs_review" ||
    chunk.status === "failed" ||
    chunk.stageRuns.some((run) => run.status === "failed")
  );
}

function latestFailedStage(chunk: Chunk): StageName | null {
  const preferred: StageName[] = ["p5", "p2v", "p2c", "p2"];
  return preferred.find((stage) => chunk.stageRuns.some((run) => run.stage === stage && run.status === "failed")) ?? null;
}

function diagnosisLabel(chunk: Chunk): string {
  if (chunk.verifyDiagnosis?.detail) return chunk.verifyDiagnosis.detail;
  if (chunk.verifyDiagnosis?.type === "speed_anomaly") return "语速异常，建议先听 take 再决定是否改稿。";
  if (chunk.verifyDiagnosis?.type === "silence_anomaly") return "静音异常，建议先检查音频边界。";
  const failedStage = latestFailedStage(chunk);
  return failedStage ? `${STAGE_SHORT_LABEL[failedStage]}失败，建议优先排查。` : "需要人工复核。";
}

function countStageFailures(chunks: Chunk[], stage: StageName) {
  return chunks.filter((chunk) => chunk.stageRuns.some((run) => run.stage === stage && run.status === "failed")).length;
}

export function ReviewWorkbench({
  chunks,
  stagedChunkCount,
  filterMode,
  onFilterModeChange,
  onBatchRetry,
  onApplyStaged,
}: Props) {
  const reviewChunks = chunks.filter(isProblemChunk);
  if (reviewChunks.length === 0 && stagedChunkCount === 0) return null;

  const speedCount = reviewChunks.filter((chunk) => chunk.verifyDiagnosis?.type === "speed_anomaly").length;
  const silenceCount = reviewChunks.filter((chunk) => chunk.verifyDiagnosis?.type === "silence_anomaly").length;
  const p2Count = countStageFailures(reviewChunks, "p2");
  const p2vCount = countStageFailures(reviewChunks, "p2v");
  const p5Count = countStageFailures(reviewChunks, "p5");
  const reviewChunkIds = reviewChunks.map((chunk) => chunk.id);
  const todoList = reviewChunks.slice(0, 8);

  return (
    <div className="px-6 py-3 border-b border-neutral-100 dark:border-neutral-700 bg-amber-50/60 dark:bg-amber-950/10 shrink-0">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">异常工作台</div>
        <span className="rounded-full border border-amber-200 bg-white px-2 py-0.5 text-xs text-amber-700 dark:border-amber-800 dark:bg-neutral-900 dark:text-amber-300">
          待处理 {reviewChunks.length}
        </span>
        {stagedChunkCount > 0 ? (
          <span className="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-xs text-blue-700 dark:border-blue-800 dark:bg-neutral-900 dark:text-blue-300">
            已暂存 {stagedChunkCount}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => onFilterModeChange(filterMode === "review" ? "all" : "review")}
          className="ml-auto rounded border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-700 hover:bg-white dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          {filterMode === "review" ? "查看全部 chunk" : "只看异常 chunk"}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-neutral-600 dark:text-neutral-300">
        {speedCount > 0 ? <span className="rounded bg-white px-2 py-0.5 dark:bg-neutral-900">语速异常 {speedCount}</span> : null}
        {silenceCount > 0 ? <span className="rounded bg-white px-2 py-0.5 dark:bg-neutral-900">静音异常 {silenceCount}</span> : null}
        {p2Count > 0 ? <span className="rounded bg-white px-2 py-0.5 dark:bg-neutral-900">配音失败 {p2Count}</span> : null}
        {p2vCount > 0 ? <span className="rounded bg-white px-2 py-0.5 dark:bg-neutral-900">复核失败 {p2vCount}</span> : null}
        {p5Count > 0 ? <span className="rounded bg-white px-2 py-0.5 dark:bg-neutral-900">出字失败 {p5Count}</span> : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onBatchRetry("p2", reviewChunkIds)}
          className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          批量配音
        </button>
        <button
          type="button"
          onClick={() => onBatchRetry("p2v", reviewChunkIds)}
          className="rounded border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          批量复核
        </button>
        <button
          type="button"
          onClick={() => onBatchRetry("p5", reviewChunkIds)}
          className="rounded border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          批量出字
        </button>
        {stagedChunkCount > 0 ? (
          <button
            type="button"
            onClick={onApplyStaged}
            className="rounded border border-blue-300 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-950/30"
          >
            统一应用暂存修改
          </button>
        ) : null}
      </div>

      {todoList.length > 0 ? (
        <div className="mt-3 rounded-lg border border-amber-200/70 bg-white/80 dark:border-amber-900/40 dark:bg-neutral-900/60">
          <div className="px-3 py-2 text-[11px] font-semibold text-neutral-600 dark:text-neutral-300 border-b border-neutral-100 dark:border-neutral-800">
            优先待办
          </div>
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {todoList.map((chunk) => (
              <div key={chunk.id} className="px-3 py-2 flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{chunk.id}</span>
                <span className="flex-1 min-w-[240px] text-[11px] text-neutral-700 dark:text-neutral-200">{diagnosisLabel(chunk)}</span>
                <button
                  type="button"
                  onClick={() => onBatchRetry("p2", [chunk.id])}
                  className="rounded border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  配音
                </button>
                <button
                  type="button"
                  onClick={() => onBatchRetry("p2v", [chunk.id])}
                  className="rounded border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  复核
                </button>
                <button
                  type="button"
                  onClick={() => onBatchRetry("p5", [chunk.id])}
                  className="rounded border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  出字
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
