"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Chunk, StageName } from "@/lib/types";
import { useHarnessStore } from "@/lib/store";
import { ChunkEditor } from "./ChunkEditor";
import { ChunkRow, type DisplayMode } from "./ChunkRow";
import { GRID_COLS } from "./chunks-grid";

export type ChunkFilterMode = "all" | "review" | "staged";

interface Props {
  episodeId: string;
  episodeConfig: Record<string, unknown>;
  chunks: Chunk[];
  filterMode?: ChunkFilterMode;
  onFilterModeChange?: (mode: ChunkFilterMode) => void;
  onStageClick?: (cid: string, stage: StageName) => void;
  onPreviewTake?: (cid: string, takeId: string) => void;
  onUseTake?: (cid: string, takeId: string) => void;
  onSynthesize?: (cid: string) => void;
  onQuickRetry?: (cid: string, stage: StageName) => void | Promise<void>;
  onConfirmReview?: (cid: string) => void | Promise<void>;
  onGapChange?: (cid: string, nextGapMs: number | null) => void | Promise<void>;
  onGapPreview?: (cid: string, gapMs: number) => Promise<Blob>;
  onEpisodeGapPreview?: () => Promise<Blob>;
  pendingStages?: Record<string, { stage: StageName }>;
  getAudioUrl: (uri: string) => string;
}

function isProblemChunk(chunk: Chunk): boolean {
  return (
    chunk.status === "needs_review" ||
    chunk.status === "failed" ||
    (chunk.status !== "verified" && chunk.stageRuns.some((stageRun) => stageRun.status === "failed"))
  );
}

export function ChunksTable({
  episodeId,
  episodeConfig,
  chunks,
  filterMode,
  onFilterModeChange,
  onStageClick,
  onPreviewTake,
  onUseTake,
  onSynthesize,
  onQuickRetry,
  onConfirmReview,
  onGapChange,
  onGapPreview,
  onEpisodeGapPreview,
  pendingStages,
  getAudioUrl,
}: Props) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>("subtitle");
  const [localFilterMode, setLocalFilterMode] = useState<ChunkFilterMode>(filterMode ?? "all");
  const [gapEditorOpen, setGapEditorOpen] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const editing = useHarnessStore((state) => state.editing);
  const edits = useHarnessStore((state) => state.edits);

  useEffect(() => {
    if (filterMode) setLocalFilterMode(filterMode);
  }, [filterMode]);

  const setFilterMode = (mode: ChunkFilterMode) => {
    setLocalFilterMode(mode);
    onFilterModeChange?.(mode);
  };

  const reviewCount = chunks.filter(isProblemChunk).length;
  const stagedCount = chunks.filter((chunk) => Boolean(edits[chunk.id])).length;

  const visibleChunks = chunks.filter((chunk) => {
    if (localFilterMode === "review") return isProblemChunk(chunk);
    if (localFilterMode === "staged") return Boolean(edits[chunk.id]);
    return true;
  });
  const showGapControls = gapEditorOpen && localFilterMode === "all";

  const virtualizer = useVirtualizer({
    count: visibleChunks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback((index: number) => {
      const chunk = visibleChunks[index];
      const gapHeight = showGapControls && index < visibleChunks.length - 1 ? 126 : 0;
      if (editing === chunk?.id) return 320 + gapHeight;
      return 60 + gapHeight;
    }, [editing, showGapControls, visibleChunks]),
    overscan: 5,
  });

  if (chunks.length === 0) {
    return (
      <div className="px-6 py-12 text-center text-sm text-neutral-400 dark:text-neutral-500">
        还没有 chunk。先在上方执行切稿或运行整条流程。
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-amber-100 bg-amber-50/50 px-6 py-2 text-xs dark:border-amber-900/60 dark:bg-amber-950/15">
        <div className="min-w-0 text-neutral-600 dark:text-neutral-300">
          <span className="font-medium text-amber-800 dark:text-amber-200">Chunk 空隙</span>
          <span className="ml-2 text-neutral-500 dark:text-neutral-400">
            调整当前 chunk 到下一个 chunk 的毫秒间隙，负值会重叠播放。
          </span>
        </div>
        <button
          type="button"
          disabled={localFilterMode !== "all" || chunks.length < 2}
          onClick={() => setGapEditorOpen((open) => !open)}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
            showGapControls
              ? "border-amber-500 bg-amber-600 text-white hover:bg-amber-700"
              : "border-amber-300 bg-white text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-neutral-900 dark:text-amber-200 dark:hover:bg-amber-950"
          } disabled:cursor-not-allowed disabled:opacity-40`}
          title={localFilterMode === "all" ? undefined : "请先切回完整列表，避免把过滤后的可见相邻误当成真实相邻"}
        >
          {showGapControls ? "关闭 chunk 空隙" : "打开 chunk 空隙"}
        </button>
      </div>
      <div
        className="grid text-[11px] text-neutral-400 dark:text-neutral-500 uppercase tracking-wide border-b border-neutral-100 dark:border-neutral-700 shrink-0"
        style={{ gridTemplateColumns: GRID_COLS }}
      >
        <div className="text-left font-medium px-6 py-2">ID</div>
        <div className="text-left font-medium py-2">状态</div>
        <div className="text-left font-medium py-2">时长</div>
        <div className="text-left font-medium py-2">播放</div>
        <div className="text-left font-medium py-2 pr-6">
          <div className="flex items-center gap-2">
            <span>{displayMode === "subtitle" ? "字幕" : "TTS 源"}</span>
            <div className="inline-flex rounded border border-neutral-200 dark:border-neutral-700 overflow-hidden normal-case">
              <button
                type="button"
                onClick={() => setDisplayMode("subtitle")}
                className={`px-1.5 py-0.5 text-[10px] font-normal ${
                  displayMode === "subtitle"
                    ? "bg-neutral-900 dark:bg-white text-white dark:text-neutral-900"
                    : "bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                }`}
              >
                字幕
              </button>
              <button
                type="button"
                onClick={() => setDisplayMode("tts")}
                className={`px-1.5 py-0.5 text-[10px] font-normal border-l border-neutral-200 dark:border-neutral-700 ${
                  displayMode === "tts"
                    ? "bg-neutral-900 dark:bg-white text-white dark:text-neutral-900"
                    : "bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                }`}
              >
                TTS 源
              </button>
            </div>
            <div className="inline-flex rounded border border-neutral-200 dark:border-neutral-700 overflow-hidden normal-case">
              <button
                type="button"
                onClick={() => setFilterMode("all")}
                className={`px-1.5 py-0.5 text-[10px] font-normal ${
                  localFilterMode === "all"
                    ? "bg-neutral-900 dark:bg-white text-white dark:text-neutral-900"
                    : "bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                }`}
              >
                全部
              </button>
              <button
                type="button"
                onClick={() => setFilterMode("review")}
                className={`px-1.5 py-0.5 text-[10px] font-normal border-l border-neutral-200 dark:border-neutral-700 ${
                  localFilterMode === "review"
                    ? "bg-neutral-900 dark:bg-white text-white dark:text-neutral-900"
                    : "bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                }`}
              >
                异常 {reviewCount}
              </button>
              <button
                type="button"
                onClick={() => setFilterMode("staged")}
                className={`px-1.5 py-0.5 text-[10px] font-normal border-l border-neutral-200 dark:border-neutral-700 ${
                  localFilterMode === "staged"
                    ? "bg-neutral-900 dark:bg-white text-white dark:text-neutral-900"
                    : "bg-white dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                }`}
              >
                暂存 {stagedCount}
              </button>
            </div>
          </div>
        </div>
        <div className="text-right font-medium py-2 pr-6">操作</div>
      </div>

      <div ref={parentRef} className="flex-1 overflow-y-auto">
        {visibleChunks.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-neutral-400 dark:text-neutral-500">
            {localFilterMode === "review" ? "当前没有异常 chunk。" : "当前没有已暂存的 chunk。"}
          </div>
        ) : null}
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const chunk = visibleChunks[virtualRow.index];
            const nextChunk = showGapControls ? (visibleChunks[virtualRow.index + 1] ?? null) : null;
            return (
              <div
                key={chunk.id}
                data-index={virtualRow.index}
                data-chunk-id={chunk.id}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <RowGroup
                  episodeId={episodeId}
                  chunk={chunk}
                  nextChunk={nextChunk}
                  episodeConfig={episodeConfig}
                  displayMode={displayMode}
                  showGapControl={showGapControls}
                  onStageClick={onStageClick ? (stage) => onStageClick(chunk.id, stage) : undefined}
                  onPreviewTake={onPreviewTake ? (takeId) => onPreviewTake(chunk.id, takeId) : undefined}
                  onUseTake={onUseTake ? (takeId) => onUseTake(chunk.id, takeId) : undefined}
                  onSynthesize={onSynthesize ? () => onSynthesize(chunk.id) : undefined}
                  onQuickRetry={onQuickRetry ? (stage) => onQuickRetry(chunk.id, stage) : undefined}
                  onConfirmReview={onConfirmReview ? () => onConfirmReview(chunk.id) : undefined}
                  onGapChange={onGapChange}
                  onGapPreview={onGapPreview}
                  processingStage={pendingStages?.[chunk.id]?.stage ?? null}
                  getAudioUrl={getAudioUrl}
                />
              </div>
            );
          })}
        </div>
        {showGapControls ? (
          <EpisodeGapPreviewControl
            chunkCount={chunks.length}
            onPreview={onEpisodeGapPreview}
          />
        ) : null}
      </div>
    </div>
  );
}

interface RowGroupProps {
  episodeId: string;
  chunk: Chunk;
  nextChunk: Chunk | null;
  episodeConfig: Record<string, unknown>;
  displayMode: DisplayMode;
  showGapControl: boolean;
  onStageClick?: (stage: StageName) => void;
  onPreviewTake?: (takeId: string) => void;
  onUseTake?: (takeId: string) => void;
  onSynthesize?: () => void;
  onQuickRetry?: (stage: StageName) => void | Promise<void>;
  onConfirmReview?: () => void | Promise<void>;
  onGapChange?: (cid: string, nextGapMs: number | null) => void | Promise<void>;
  onGapPreview?: (cid: string, gapMs: number) => Promise<Blob>;
  processingStage?: StageName | null;
  getAudioUrl: (uri: string) => string;
}

const RowGroup = memo(function RowGroup({
  episodeId,
  chunk,
  nextChunk,
  episodeConfig,
  displayMode,
  showGapControl,
  onStageClick,
  onPreviewTake,
  onUseTake,
  onSynthesize,
  onQuickRetry,
  onConfirmReview,
  onGapChange,
  onGapPreview,
  processingStage,
  getAudioUrl,
}: RowGroupProps) {
  void episodeId;
  const isEditing = useHarnessStore((state) => state.editing === chunk.id);
  const edit = useHarnessStore((state) => state.edits[chunk.id]);
  const stageEdit = useHarnessStore((state) => state.stageEdit);
  const cancelEditing = useHarnessStore((state) => state.cancelEditing);

  return (
    <>
      <ChunkRow
        chunk={chunk}
        episodeConfig={episodeConfig}
        displayMode={displayMode}
        onStageClick={onStageClick}
        onPreviewTake={onPreviewTake}
        onUseTake={onUseTake}
        onSynthesize={onSynthesize}
        onQuickRetry={onQuickRetry}
        onConfirmReview={onConfirmReview}
        processingStage={processingStage}
        getAudioUrl={getAudioUrl}
      />
      {showGapControl && nextChunk ? (
        <ChunkGapControl
          chunk={chunk}
          nextChunk={nextChunk}
          onGapChange={onGapChange}
          onGapPreview={onGapPreview}
        />
      ) : null}
      {isEditing ? (
        <ChunkEditor
          chunk={chunk}
          episodeConfig={episodeConfig}
          initialDraft={edit}
          onStage={(draft) => stageEdit(chunk.id, draft)}
          onCancel={cancelEditing}
        />
      ) : null}
    </>
  );
}, (prev, next) => {
  return prev.chunk === next.chunk
    && prev.nextChunk === next.nextChunk
    && prev.episodeConfig === next.episodeConfig
    && prev.displayMode === next.displayMode
    && prev.showGapControl === next.showGapControl
    && prev.processingStage === next.processingStage
    && prev.onStageClick === next.onStageClick
    && prev.onPreviewTake === next.onPreviewTake
    && prev.onUseTake === next.onUseTake
    && prev.onSynthesize === next.onSynthesize
    && prev.onQuickRetry === next.onQuickRetry
    && prev.onGapChange === next.onGapChange
    && prev.onGapPreview === next.onGapPreview
    && prev.getAudioUrl === next.getAudioUrl;
});

function defaultGapMs(chunk: Chunk, nextChunk: Chunk): number {
  void chunk;
  void nextChunk;
  return 0;
}

function clampGapMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1000, Math.min(2000, Math.round(value)));
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw === "Not Found") {
    return "未找到对应资源。通常是关联音频不存在，或当前接口还没有成功生效。";
  }
  if (raw.includes("audio not found:")) {
    return "未找到预览所需音频文件，请确认当前 chunk 和下一个 chunk 的已选 take 都仍然可用。";
  }
  if (raw.includes("both chunks must have selected takes before preview")) {
    return "当前 chunk 和下一个 chunk 都必须先有已选中的 take，才能预览拼接。";
  }
  if (raw.includes("last chunk has no next chunk to preview")) {
    return "最后一个 chunk 没有下一个 chunk，无法预览拼接。";
  }
  if (raw.includes("all chunks must have selected takes before preview")) {
    return "整体验证前，需要所有 chunk 都已有选中的 take。";
  }
  if (raw.includes("episode has no chunks to preview") || raw.includes("episode has no previewable chunks")) {
    return "当前没有可用于整体预览的 chunk。";
  }
  return raw;
}

function ChunkGapControl({
  chunk,
  nextChunk,
  onGapChange,
  onGapPreview,
}: {
  chunk: Chunk;
  nextChunk: Chunk;
  onGapChange?: (cid: string, nextGapMs: number | null) => void | Promise<void>;
  onGapPreview?: (cid: string, gapMs: number) => Promise<Blob>;
}) {
  const fallbackGap = defaultGapMs(chunk, nextChunk);
  const currentGap = chunk.nextGapMs ?? fallbackGap;
  const isCustom = chunk.nextGapMs !== null && chunk.nextGapMs !== undefined;
  const [draft, setDraft] = useState(currentGap);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    setDraft(currentGap);
  }, [chunk.id, nextChunk.id, currentGap]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const commit = async (nextGapMs: number | null) => {
    if (!onGapChange) return;
    const normalized = nextGapMs == null ? null : clampGapMs(nextGapMs);
    setSaving(true);
    setError(null);
    try {
      await onGapChange(chunk.id, normalized);
      if (normalized != null) setDraft(normalized);
    } catch (err) {
      setDraft(currentGap);
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    if (!onGapPreview) return;
    setPreviewing(true);
    setError(null);
    try {
      const blob = await onGapPreview(chunk.id, clampGapMs(draft));
      const url = URL.createObjectURL(blob);
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="mx-6 my-2 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-xs text-neutral-700 shadow-sm dark:border-amber-800 dark:bg-amber-950/20 dark:text-neutral-200">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[168px] font-medium text-amber-800 dark:text-amber-200">
          到下一个 chunk 的空隙
          <span className="ml-2 font-normal text-neutral-500 dark:text-neutral-400">
            {chunk.id} {"->"} {nextChunk.id}
          </span>
        </div>
        <input
          type="range"
          min={-1000}
          max={2000}
          step={10}
          value={draft}
          onChange={(event) => setDraft(clampGapMs(Number(event.target.value)))}
          onPointerUp={() => { void commit(draft); }}
          onKeyUp={(event) => {
            if (event.key === "Enter") void commit(draft);
          }}
          className="min-w-[180px] flex-1 accent-amber-600"
          aria-label="Chunk boundary gap milliseconds"
        />
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={-1000}
            max={2000}
            step={10}
            value={draft}
            onChange={(event) => setDraft(clampGapMs(Number(event.target.value)))}
            onBlur={() => { void commit(draft); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="w-20 rounded border border-amber-200 bg-white px-2 py-1 text-right tabular-nums dark:border-amber-800 dark:bg-neutral-900"
          />
          <span className="text-neutral-500 dark:text-neutral-400">ms</span>
        </div>
        <button
          type="button"
          onClick={() => { void commit(null); }}
          disabled={saving || !isCustom}
          className="rounded border border-amber-200 bg-white px-2 py-1 text-amber-700 hover:bg-amber-100 disabled:opacity-40 dark:border-amber-800 dark:bg-neutral-900 dark:text-amber-200 dark:hover:bg-amber-950"
        >
          重置
        </button>
        <button
          type="button"
          onClick={() => { void handlePreview(); }}
          disabled={previewing || !onGapPreview}
          className="rounded bg-amber-600 px-2.5 py-1 font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {previewing ? "预览中..." : "预览拼接"}
        </button>
        {saving ? <span className="text-amber-700 dark:text-amber-200">保存中...</span> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>默认：{fallbackGap} ms</span>
        <span>正值会插入静音，负值会让下一段提前进入并与当前段重叠。</span>
        {isCustom ? <span className="text-amber-700 dark:text-amber-200">已自定义</span> : null}
      </div>
      {previewUrl ? (
        <audio controls src={previewUrl} className="mt-2 h-8 w-full" />
      ) : null}
      {error ? (
        <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function EpisodeGapPreviewControl({
  chunkCount,
  onPreview,
}: {
  chunkCount: number;
  onPreview?: () => Promise<Blob>;
}) {
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handlePreview = async () => {
    if (!onPreview) return;
    setPreviewing(true);
    setError(null);
    try {
      const blob = await onPreview();
      const url = URL.createObjectURL(blob);
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="mx-6 mt-2 mb-4 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-xs text-neutral-700 shadow-sm dark:border-amber-800 dark:bg-amber-950/20 dark:text-neutral-200">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[168px] font-medium text-amber-800 dark:text-amber-200">
          整体拼接预览
          <span className="ml-2 font-normal text-neutral-500 dark:text-neutral-400">
            {chunkCount} 个 chunk
          </span>
        </div>
        <div className="flex-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          按当前所有 chunk 的已选 take 和空隙设置临时拼接，只用于试听，不会保存。
        </div>
        <button
          type="button"
          onClick={() => { void handlePreview(); }}
          disabled={previewing || !onPreview}
          className="rounded bg-amber-600 px-2.5 py-1 font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {previewing ? "预览中..." : "预览整体拼接"}
        </button>
      </div>
      {previewUrl ? (
        <audio controls src={previewUrl} className="mt-2 h-8 w-full" />
      ) : null}
      {error ? (
        <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  );
}
