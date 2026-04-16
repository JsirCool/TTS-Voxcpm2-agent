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
  chunks: Chunk[];
  filterMode?: ChunkFilterMode;
  onFilterModeChange?: (mode: ChunkFilterMode) => void;
  onStageClick?: (cid: string, stage: StageName) => void;
  onPreviewTake?: (cid: string, takeId: string) => void;
  onUseTake?: (cid: string, takeId: string) => void;
  onSynthesize?: (cid: string) => void;
  onQuickRetry?: (cid: string, stage: StageName) => void | Promise<void>;
  synthesizingCid?: string | null;
  getAudioUrl: (uri: string) => string;
}

function isProblemChunk(chunk: Chunk): boolean {
  return (
    chunk.status === "needs_review" ||
    chunk.status === "failed" ||
    chunk.stageRuns.some((stageRun) => stageRun.status === "failed")
  );
}

export function ChunksTable({
  episodeId,
  chunks,
  filterMode,
  onFilterModeChange,
  onStageClick,
  onPreviewTake,
  onUseTake,
  onSynthesize,
  onQuickRetry,
  synthesizingCid,
  getAudioUrl,
}: Props) {
  void episodeId;
  const [displayMode, setDisplayMode] = useState<DisplayMode>("subtitle");
  const [localFilterMode, setLocalFilterMode] = useState<ChunkFilterMode>(filterMode ?? "all");
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

  const virtualizer = useVirtualizer({
    count: visibleChunks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback((index: number) => {
      const chunk = visibleChunks[index];
      if (editing === chunk?.id) return 320;
      return 60;
    }, [editing, visibleChunks]),
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
    <div className="flex flex-col h-full overflow-x-auto">
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
                  chunk={chunk}
                  displayMode={displayMode}
                  onStageClick={onStageClick ? (stage) => onStageClick(chunk.id, stage) : undefined}
                  onPreviewTake={onPreviewTake ? (takeId) => onPreviewTake(chunk.id, takeId) : undefined}
                  onUseTake={onUseTake ? (takeId) => onUseTake(chunk.id, takeId) : undefined}
                  onSynthesize={onSynthesize ? () => onSynthesize(chunk.id) : undefined}
                  onQuickRetry={onQuickRetry ? (stage) => onQuickRetry(chunk.id, stage) : undefined}
                  synthesizing={synthesizingCid === chunk.id}
                  getAudioUrl={getAudioUrl}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface RowGroupProps {
  chunk: Chunk;
  displayMode: DisplayMode;
  onStageClick?: (stage: StageName) => void;
  onPreviewTake?: (takeId: string) => void;
  onUseTake?: (takeId: string) => void;
  onSynthesize?: () => void;
  onQuickRetry?: (stage: StageName) => void | Promise<void>;
  synthesizing?: boolean;
  getAudioUrl: (uri: string) => string;
}

const RowGroup = memo(function RowGroup({
  chunk,
  displayMode,
  onStageClick,
  onPreviewTake,
  onUseTake,
  onSynthesize,
  onQuickRetry,
  synthesizing,
  getAudioUrl,
}: RowGroupProps) {
  const isEditing = useHarnessStore((state) => state.editing === chunk.id);
  const edit = useHarnessStore((state) => state.edits[chunk.id]);
  const stageEdit = useHarnessStore((state) => state.stageEdit);
  const cancelEditing = useHarnessStore((state) => state.cancelEditing);

  return (
    <>
      <ChunkRow
        chunk={chunk}
        displayMode={displayMode}
        onStageClick={onStageClick}
        onPreviewTake={onPreviewTake}
        onUseTake={onUseTake}
        onSynthesize={onSynthesize}
        onQuickRetry={onQuickRetry}
        synthesizing={synthesizing}
        getAudioUrl={getAudioUrl}
      />
      {isEditing ? (
        <ChunkEditor
          chunk={chunk}
          initialDraft={edit}
          onStage={(draft) => stageEdit(chunk.id, draft)}
          onCancel={cancelEditing}
        />
      ) : null}
    </>
  );
}, (prev, next) => {
  return prev.chunk === next.chunk
    && prev.displayMode === next.displayMode
    && prev.synthesizing === next.synthesizing
    && prev.onStageClick === next.onStageClick
    && prev.onPreviewTake === next.onPreviewTake
    && prev.onUseTake === next.onUseTake
    && prev.onSynthesize === next.onSynthesize
    && prev.onQuickRetry === next.onQuickRetry
    && prev.getAudioUrl === next.getAudioUrl;
});
