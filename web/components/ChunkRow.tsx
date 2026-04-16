"use client";

import { memo, useCallback, useState } from "react";
import { CHUNK_STAGE_ORDER, type Chunk, type ChunkEdit, type ChunkStatus, type StageName } from "@/lib/types";
import { STAGE_SHORT_LABEL } from "@/lib/stage-labels";
import { getDisplaySubtitle, stripControlMarkers } from "@/lib/utils";
import { useHarnessStore } from "@/lib/store";
import { useAudioPlayer } from "@/hooks/useAudioPlayer";
import { KaraokeSubtitle } from "./KaraokeSubtitle";
import { RetryRow } from "./RetryRow";
import { StagePipeline } from "./StagePipeline";
import { TakeSelector } from "./TakeSelector";
import { VerifyScoreBar } from "./VerifyScoreBar";
import { GRID_COLS } from "./chunks-grid";

export type DirtyType = null | "tts" | "subtitle" | "both";
export type DisplayMode = "subtitle" | "tts";

interface Props {
  chunk: Chunk;
  displayMode: DisplayMode;
  onStageClick?: (stage: StageName) => void;
  onPreviewTake?: (takeId: string) => void;
  onUseTake?: (takeId: string) => void;
  onSynthesize?: () => void;
  onQuickRetry?: (stage: StageName) => void | Promise<void>;
  processingStage?: StageName | null;
  getAudioUrl: (uri: string) => string;
}

function computeDirty(edit: ChunkEdit | undefined): DirtyType {
  if (!edit) return null;
  const hasTts = edit.textNormalized !== undefined;
  const hasSub = edit.subtitleText !== undefined;
  if (hasTts && hasSub) return "both";
  if (hasTts) return "tts";
  if (hasSub) return "subtitle";
  return null;
}

function getReviewSuggestion(chunk: Chunk): string | null {
  if (chunk.status !== "needs_review" && chunk.status !== "failed") return null;
  const diagnosisType = chunk.verifyDiagnosis?.type;
  if (diagnosisType === "speed_anomaly") {
    return "建议先检查 TTS 源文本和语速，再决定是否重跑配音。";
  }
  if (diagnosisType === "silence_anomaly") {
    return "建议先试听当前 take，确认静音段后再重跑配音或改稿。";
  }
  if (chunk.stageRuns.some((stageRun) => stageRun.stage === "p2v" && stageRun.status === "failed")) {
    return "建议先看复核日志，确认是 WhisperX 不可用还是质量门槛未通过。";
  }
  return "建议先试听当前 take，再决定重跑、换 take 或手动修改。";
}

function getQuickRetryStage(chunk: Chunk): StageName {
  const failedStage = (["p5", "p2v", "p2c", "p2"] as StageName[]).find((stage) =>
    chunk.stageRuns.some((run) => run.stage === stage && run.status === "failed"),
  );
  if (failedStage) return failedStage;
  if (chunk.status === "needs_review") return "p2";
  return "p2";
}

function statusIcon(status: ChunkStatus) {
  switch (status) {
    case "verified":
      return <span className="text-emerald-500">✓</span>;
    case "synth_done":
      return <span className="text-blue-500">●</span>;
    case "needs_review":
      return <span className="text-amber-500">!</span>;
    case "failed":
      return <span className="text-red-500">×</span>;
    default:
      return <span className="text-neutral-300 dark:text-neutral-600">●</span>;
  }
}

function getRunningChunkStage(chunk: Chunk): StageName | null {
  return CHUNK_STAGE_ORDER.find((stage) =>
    chunk.stageRuns.some((stageRun) => stageRun.stage === stage && stageRun.status === "running"),
  ) ?? null;
}

function getChunkProgress(chunk: Chunk, processingStage: StageName | null | undefined) {
  const activeStage = getRunningChunkStage(chunk) ?? processingStage ?? null;
  if (!activeStage || !CHUNK_STAGE_ORDER.includes(activeStage)) return null;

  const currentIndex = CHUNK_STAGE_ORDER.indexOf(activeStage);
  const completedCount = CHUNK_STAGE_ORDER.slice(0, currentIndex).filter((stage) =>
    chunk.stageRuns.some((stageRun) => stageRun.stage === stage && stageRun.status === "ok"),
  ).length;

  return {
    activeStage,
    currentIndex,
    completedCount,
    progressPercent: Math.max(12, ((completedCount + 0.45) / CHUNK_STAGE_ORDER.length) * 100),
    isConfirmedRunning: getRunningChunkStage(chunk) === activeStage,
  };
}

export const ChunkRow = memo(function ChunkRow({
  chunk,
  displayMode,
  onStageClick,
  onPreviewTake,
  onUseTake,
  onSynthesize,
  onQuickRetry,
  processingStage = null,
  getAudioUrl,
}: Props) {
  const isEditing = useHarnessStore((state) => state.editing === chunk.id);
  const edit = useHarnessStore((state) => state.edits[chunk.id]);
  const startEditing = useHarnessStore((state) => state.startEditing);
  const cancelEditing = useHarnessStore((state) => state.cancelEditing);

  const dirty = computeDirty(edit);
  const isDirty = dirty !== null;
  const hasSubtitleField = chunk.subtitleText != null;

  const currentTake = chunk.takes.find((take) => take.id === chunk.selectedTakeId);
  const cacheBust = currentTake?.createdAt
    ? `?v=${encodeURIComponent(currentTake.createdAt)}`
    : `?v=${chunk.charCount}`;
  const audioUrl =
    chunk.selectedTakeId &&
    currentTake &&
    (chunk.status === "synth_done" || chunk.status === "verified" || chunk.status === "needs_review")
      ? getAudioUrl(currentTake.audioUri) + cacheBust
      : "";

  const displayText = displayMode === "tts"
    ? (edit?.textNormalized !== undefined ? edit.textNormalized : chunk.textNormalized)
    : (edit?.subtitleText !== undefined ? stripControlMarkers(edit.subtitleText) : getDisplaySubtitle(chunk));

  const durationS = currentTake?.durationS ?? 0;
  const player = useAudioPlayer(chunk.id, durationS, audioUrl);
  const { isPlaying } = player;

  const [verifyExpanded, setVerifyExpanded] = useState(false);
  const toggleVerify = useCallback(() => setVerifyExpanded((value) => !value), []);

  const hasAudio = chunk.status === "synth_done" || chunk.status === "verified" || chunk.status === "needs_review";
  const canPlay = hasAudio && Boolean(audioUrl) && !isDirty;
  const needsSynth = chunk.status === "pending" && !isDirty;
  const onEdit = () => startEditing(chunk.id);
  const progressState = getChunkProgress(chunk, processingStage);
  const isProcessing = Boolean(progressState);

  const rowBg = isPlaying
    ? "bg-blue-50 dark:bg-blue-900/20 shadow-[inset_3px_0_0_#2563eb]"
    : isEditing
      ? "bg-neutral-50 dark:bg-neutral-800"
      : chunk.status === "needs_review"
        ? "bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100/60 dark:hover:bg-amber-900/30"
        : isDirty
          ? "bg-amber-50/30 dark:bg-amber-900/10 hover:bg-amber-50/50 dark:hover:bg-amber-900/20"
          : "hover:bg-neutral-50 dark:hover:bg-neutral-800";

  let dirtyBadge: string | null = null;
  if (dirty === "tts") dirtyBadge = "TTS 已暂存";
  else if (dirty === "subtitle") dirtyBadge = "字幕已暂存";
  else if (dirty === "both") dirtyBadge = "TTS+字幕已暂存";

  const baseColor = isDirty ? "text-amber-900 dark:text-amber-200" : "text-neutral-700 dark:text-neutral-300";
  const reviewSuggestion = getReviewSuggestion(chunk);
  const quickRetryStage = getQuickRetryStage(chunk);
  const quickRetryLabel = STAGE_SHORT_LABEL[quickRetryStage];

  return (
    <div
      className={`grid border-b border-neutral-100 dark:border-neutral-700 text-sm ${rowBg}`}
      style={{ gridTemplateColumns: GRID_COLS }}
    >
      <div className="px-6 py-2.5 font-mono text-[11px] text-neutral-500 dark:text-neutral-400 self-start">
        {chunk.id}
        {hasSubtitleField ? (
          <span className="ml-1 text-[9px] text-purple-500" title="已设置 subtitle_text">
            •
          </span>
        ) : null}
      </div>
      <div className="py-2.5 self-start">{statusIcon(chunk.status)}</div>
      <div className="py-2.5 self-start text-[11px] text-neutral-500 dark:text-neutral-400 font-mono">
        {durationS > 0 ? `${durationS.toFixed(1)}s` : "--"}
      </div>
      <div className="py-2.5 self-start">
        {needsSynth ? (
          <button
            type="button"
            onClick={onSynthesize}
            disabled={isProcessing}
            title="合成并播放"
            className={`w-7 h-7 inline-flex items-center justify-center rounded ${
              isProcessing ? "text-blue-400 animate-pulse cursor-wait" : "hover:bg-blue-100 text-blue-600"
            }`}
          >
            ▶
          </button>
        ) : (
          <button
            type="button"
            onClick={player.toggle}
            disabled={!canPlay}
            title={isDirty ? "有暂存修改，请先统一应用" : ""}
            className={`w-7 h-7 inline-flex items-center justify-center rounded ${
              canPlay
                ? "hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300"
                : "text-neutral-300 dark:text-neutral-600 cursor-not-allowed"
            } ${isPlaying ? "bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200" : ""}`}
          >
            {isPlaying ? "❚❚" : "▶"}
          </button>
        )}
      </div>

      <div className="py-2.5 pr-6 self-start">
        <div className="flex items-start flex-wrap">
          <div className="flex-1 min-w-0">
            <KaraokeSubtitle
              text={displayText}
              durationS={durationS}
              isPlaying={isPlaying}
              currentTime={player.currentTime}
              baseColorClass={baseColor}
              onSeek={canPlay ? player.seekTo : undefined}
            />
          </div>
          {dirtyBadge ? (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-800/30 text-amber-700 dark:text-amber-300 rounded shrink-0">
              {dirtyBadge}
            </span>
          ) : null}
        </div>

        {chunk.stageRuns.length > 0 ? (
          <div className="mt-1">
            <StagePipeline stageRuns={chunk.stageRuns} onStageClick={onStageClick} compact />
          </div>
        ) : null}

        {progressState ? (
          <div className="mt-1.5 rounded-md border border-sky-200 bg-sky-50/80 px-2 py-1.5 dark:border-sky-900/50 dark:bg-sky-950/20">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-sky-700 dark:text-sky-300">
                {progressState.isConfirmedRunning ? `${STAGE_SHORT_LABEL[progressState.activeStage]}进行中` : `已提交${STAGE_SHORT_LABEL[progressState.activeStage]}`}
              </span>
              <span className="text-[10px] text-sky-600 dark:text-sky-400">
                {progressState.completedCount}/{CHUNK_STAGE_ORDER.length}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sky-100 dark:bg-sky-950/60">
              <div
                className={[
                  "h-full rounded-full transition-[width] duration-700 ease-out",
                  progressState.isConfirmedRunning ? "bg-sky-500 animate-pulse" : "bg-sky-400",
                ].join(" ")}
                style={{ width: `${progressState.progressPercent}%` }}
              />
            </div>
            <div className="mt-1.5 flex gap-1">
              {CHUNK_STAGE_ORDER.map((stage, index) => {
                const isComplete = index < progressState.currentIndex
                  && chunk.stageRuns.some((stageRun) => stageRun.stage === stage && stageRun.status === "ok");
                const isActive = stage === progressState.activeStage;
                return (
                  <span
                    key={stage}
                    title={STAGE_SHORT_LABEL[stage]}
                    className={[
                      "h-1.5 flex-1 rounded-full transition-all",
                      isComplete
                        ? "bg-emerald-500"
                        : isActive
                          ? "bg-sky-500 animate-pulse"
                          : "bg-sky-100 dark:bg-sky-950/60",
                    ].join(" ")}
                  />
                );
              })}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-sky-700/80 dark:text-sky-300/80">
              {CHUNK_STAGE_ORDER.map((stage) => (
                <span key={stage} className="min-w-0 flex-1 truncate text-center">
                  {STAGE_SHORT_LABEL[stage]}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {reviewSuggestion ? (
          <div className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            <span className="font-semibold">待人工复核</span>
            <span className="mx-1">·</span>
            <span>{chunk.verifyDiagnosis?.detail ?? reviewSuggestion}</span>
            {chunk.verifyDiagnosis?.detail ? (
              <>
                <span className="mx-1">·</span>
                <span>{reviewSuggestion}</span>
              </>
            ) : null}
          </div>
        ) : null}

        {chunk.verifyScores && chunk.verifyScores.weightedScore != null ? (
          <div className="mt-1">
            <button type="button" onClick={toggleVerify} className="flex items-center gap-1.5 text-[11px] w-full text-left group">
              <span className="text-neutral-400 dark:text-neutral-500 text-[9px] group-hover:text-neutral-600 dark:group-hover:text-neutral-300 transition-colors">
                {verifyExpanded ? "▾" : "▸"}
              </span>
              <span className="font-mono font-bold text-neutral-600 dark:text-neutral-300">
                {chunk.verifyScores.weightedScore.toFixed(2)}
              </span>
              <span
                className={`px-1 py-0.5 rounded text-[9px] font-bold ${
                  chunk.verifyDiagnosis?.verdict === "fail" || chunk.verifyScores.weightedScore < 0.7
                    ? "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300"
                    : "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                }`}
              >
                {chunk.verifyDiagnosis?.verdict === "fail" || chunk.verifyScores.weightedScore < 0.7 ? "待复核" : "通过"}
              </span>
              {chunk.verifyDiagnosis?.detail ? (
                <span
                  className="px-1 py-0.5 rounded text-[9px] bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 truncate max-w-[300px]"
                  title={chunk.verifyDiagnosis.detail}
                >
                  {chunk.verifyDiagnosis.detail}
                </span>
              ) : null}
            </button>
            {verifyExpanded ? (
              <div className="mt-1 pl-3">
                <VerifyScoreBar scores={chunk.verifyScores} />
              </div>
            ) : null}
          </div>
        ) : null}

        {chunk.takes.length > 1 ? (
          <TakeSelector
            takes={chunk.takes}
            selectedTakeId={chunk.selectedTakeId}
            onPreview={onPreviewTake}
            onUse={onUseTake}
          />
        ) : null}

        {chunk.attemptHistory && chunk.attemptHistory.length > 0 ? (
          <div className="mt-1 border border-neutral-200 dark:border-neutral-700 rounded overflow-hidden">
            {chunk.attemptHistory.map((attempt, index) => (
              <RetryRow
                key={`${attempt.attempt}-${attempt.timestamp}`}
                attempt={attempt}
                attemptIndex={index + 1}
                isCurrent={index === chunk.attemptHistory!.length - 1 && attempt.verdict === "pass"}
                onStageClick={onStageClick}
              />
            ))}
          </div>
        ) : null}

        {audioUrl ? <audio ref={player.ref} src={audioUrl} preload="metadata" className="hidden" /> : null}
      </div>

      <div className="py-2.5 pr-6 self-start text-right">
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => onQuickRetry?.(quickRetryStage)}
            disabled={isProcessing || !onQuickRetry}
            title={`快捷重跑${quickRetryLabel}`}
            className={`h-7 px-2 inline-flex items-center justify-center rounded text-[10px] font-semibold ${
              isProcessing || !onQuickRetry
                ? "bg-neutral-200 dark:bg-neutral-700 text-neutral-400 cursor-wait"
                : "border border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            ↻ {quickRetryLabel}
          </button>
          <button
            type="button"
            onClick={isEditing ? cancelEditing : onEdit}
            title={isEditing ? "关闭编辑" : "编辑"}
            className={`w-7 h-7 inline-flex items-center justify-center rounded ${
              isEditing
                ? "bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200"
                : "hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300"
            }`}
          >
            {isEditing ? "✓" : "✎"}
          </button>
        </div>
      </div>
    </div>
  );
}, (prev, next) => {
  return prev.chunk === next.chunk
    && prev.displayMode === next.displayMode
    && prev.processingStage === next.processingStage
    && prev.onStageClick === next.onStageClick
    && prev.onPreviewTake === next.onPreviewTake
    && prev.onUseTake === next.onUseTake
    && prev.onSynthesize === next.onSynthesize
    && prev.onQuickRetry === next.onQuickRetry
    && prev.getAudioUrl === next.getAudioUrl;
});
