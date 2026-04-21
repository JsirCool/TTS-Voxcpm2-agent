"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CutTarget = "start" | "end";

interface Props {
  peaks: number[];
  durationS: number;
  currentTime: number;
  startS: number;
  endS: number;
  nextCutTarget: CutTarget;
  onCut: (timeS: number) => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 64;
const ZOOM_STEP = 1.25;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.000";
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${remaining.toFixed(3).padStart(6, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value <= min) return min;
  if (value >= max) return max;
  return value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clampViewStart(viewStartS: number, durationS: number, visibleDurationS: number): number {
  return clamp(viewStartS, 0, Math.max(0, durationS - visibleDurationS));
}

function toViewportPercent(timeS: number, viewStartS: number, viewEndS: number): number {
  const visibleDurationS = Math.max(0.001, viewEndS - viewStartS);
  return ((timeS - viewStartS) / visibleDurationS) * 100;
}

export function MediaWaveformEditor({
  peaks,
  durationS,
  currentTime,
  startS,
  endS,
  nextCutTarget,
  onCut,
}: Props) {
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [viewStartS, setViewStartS] = useState(0);

  useEffect(() => {
    setHoverTime(null);
    setZoomLevel(1);
    setViewStartS(0);
  }, [durationS, peaks.length]);

  const visibleDurationS = useMemo(
    () => (durationS > 0 ? Math.max(durationS / zoomLevel, 0.05) : 0.05),
    [durationS, zoomLevel],
  );
  const safeViewStartS = clampViewStart(viewStartS, durationS, visibleDurationS);
  const viewEndS = Math.min(durationS, safeViewStartS + visibleDurationS);

  const updateZoom = useCallback((nextZoom: number, anchorRatio: number) => {
    const clampedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const nextVisibleDurationS = durationS > 0 ? Math.max(durationS / clampedZoom, 0.05) : 0.05;
    const anchorTimeS = safeViewStartS + clamp01(anchorRatio) * (viewEndS - safeViewStartS);
    const nextViewStartS = clampViewStart(
      anchorTimeS - clamp01(anchorRatio) * nextVisibleDurationS,
      durationS,
      nextVisibleDurationS,
    );
    setZoomLevel(clampedZoom);
    setViewStartS(nextViewStartS);
  }, [durationS, safeViewStartS, viewEndS]);

  const panByRatio = useCallback((ratioDelta: number) => {
    const deltaS = ratioDelta * visibleDurationS;
    setViewStartS((current) => clampViewStart(current + deltaS, durationS, visibleDurationS));
  }, [durationS, visibleDurationS]);

  const visiblePeakRange = useMemo(() => {
    const total = Math.max(1, peaks.length);
    const safeDuration = Math.max(durationS, 0.001);
    const startIndex = clamp(Math.floor((safeViewStartS / safeDuration) * total), 0, total - 1);
    const endIndex = clamp(Math.ceil((viewEndS / safeDuration) * total), startIndex + 1, total);
    return {
      startIndex,
      slice: peaks.slice(startIndex, endIndex),
    };
  }, [durationS, peaks, safeViewStartS, viewEndS]);

  const timeTicks = useMemo(() => {
    const segments = 4;
    return Array.from(
      { length: segments + 1 },
      (_, index) => safeViewStartS + ((viewEndS - safeViewStartS) * index) / segments,
    );
  }, [safeViewStartS, viewEndS]);

  const selectionStartS = Math.min(startS, endS);
  const selectionEndS = Math.max(startS, endS);
  const visibleSelectionStartS = clamp(selectionStartS, safeViewStartS, viewEndS);
  const visibleSelectionEndS = clamp(selectionEndS, safeViewStartS, viewEndS);
  const selectionVisible = visibleSelectionEndS > visibleSelectionStartS;
  const selectionLeft = selectionVisible ? toViewportPercent(visibleSelectionStartS, safeViewStartS, viewEndS) : 0;
  const selectionWidth = selectionVisible
    ? toViewportPercent(visibleSelectionEndS, safeViewStartS, viewEndS) - selectionLeft
    : 0;

  const startLeft = toViewportPercent(startS, safeViewStartS, viewEndS);
  const endLeft = toViewportPercent(endS, safeViewStartS, viewEndS);
  const playheadLeft = toViewportPercent(currentTime, safeViewStartS, viewEndS);
  const hoverLeft = hoverTime === null ? null : toViewportPercent(hoverTime, safeViewStartS, viewEndS);

  useEffect(() => {
    const node = waveformRef.current;
    if (!node) return undefined;

    const handleWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.shiftKey)) return;

      event.preventDefault();
      event.stopPropagation();

      const rect = node.getBoundingClientRect();
      const width = Math.max(rect.width, 1);
      const ratio = clamp01((event.clientX - rect.left) / width);

      if (event.ctrlKey) {
        const nextZoom = event.deltaY < 0 ? zoomLevel * ZOOM_STEP : zoomLevel / ZOOM_STEP;
        updateZoom(nextZoom, ratio);
        return;
      }

      const dominantDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      panByRatio(dominantDelta / 360);
    };

    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", handleWheel);
    };
  }, [panByRatio, updateZoom, zoomLevel]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>点击波形切一刀。第一刀是开始，第二刀是结束；`Ctrl + 滚轮` 缩放，`Shift + 滚轮` 平移。</span>
        <div className="flex flex-wrap items-center gap-2">
          <span>下一刀：{nextCutTarget === "start" ? "开始" : "结束"}</span>
          <span>缩放：{zoomLevel.toFixed(1)}x</span>
          <button
            type="button"
            onClick={() => updateZoom(zoomLevel * ZOOM_STEP, 0.5)}
            className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
          >
            放大
          </button>
          <button
            type="button"
            onClick={() => updateZoom(zoomLevel / ZOOM_STEP, 0.5)}
            className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
          >
            缩小
          </button>
          <button
            type="button"
            onClick={() => {
              setZoomLevel(1);
              setViewStartS(0);
            }}
            className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
          >
            重置视图
          </button>
        </div>
      </div>

      <div className="flex justify-between font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
        {timeTicks.map((tick, index) => (
          <span key={`${tick}-${index}`}>{formatTime(tick)}</span>
        ))}
      </div>

      <div
        ref={waveformRef}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = clamp01((event.clientX - rect.left) / rect.width);
          onCut(safeViewStartS + ratio * (viewEndS - safeViewStartS));
        }}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = clamp01((event.clientX - rect.left) / rect.width);
          setHoverTime(safeViewStartS + ratio * (viewEndS - safeViewStartS));
        }}
        onMouseLeave={() => setHoverTime(null)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onCut(currentTime);
        }}
        className="relative h-48 cursor-crosshair overflow-hidden rounded-2xl border border-neutral-200 bg-[linear-gradient(180deg,rgba(250,250,249,1),rgba(244,244,245,1))] px-3 py-3 select-none dark:border-neutral-700 dark:bg-[linear-gradient(180deg,rgba(38,38,38,1),rgba(24,24,27,1))]"
        style={{ overscrollBehavior: "contain" }}
      >
        <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent_0%,transparent_24.5%,rgba(148,163,184,0.18)_25%,transparent_25.5%,transparent_49.5%,rgba(148,163,184,0.18)_50%,transparent_50.5%,transparent_74.5%,rgba(148,163,184,0.18)_75%,transparent_75.5%,transparent_100%)]" />

        {selectionVisible ? (
          <div
            className="absolute inset-y-0 bg-amber-200/60 dark:bg-amber-500/15"
            style={{ left: `${selectionLeft}%`, width: `${selectionWidth}%` }}
          />
        ) : null}

        <svg
          viewBox={`0 0 ${Math.max(1, visiblePeakRange.slice.length)} 100`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          {visiblePeakRange.slice.map((peak, index) => {
            const x = index + 0.5;
            const halfHeight = Math.max(1.5, peak * 42);
            const center = 50;
            const absoluteIndex = visiblePeakRange.startIndex + index;
            const total = Math.max(1, peaks.length);
            const barTimeS = (absoluteIndex / total) * durationS;
            const inSelection = barTimeS >= selectionStartS && barTimeS <= selectionEndS;
            return (
              <line
                key={absoluteIndex}
                x1={x}
                y1={center - halfHeight}
                x2={x}
                y2={center + halfHeight}
                stroke={inSelection ? "#ea580c" : "#334155"}
                strokeOpacity={inSelection ? 0.85 : 0.55}
                strokeWidth={0.9}
                strokeLinecap="round"
              />
            );
          })}
        </svg>

        <div
          className="absolute inset-y-2 w-px bg-emerald-500/90 shadow-[0_0_0_1px_rgba(16,185,129,0.15)]"
          style={{ left: `${playheadLeft}%` }}
        />
        <div className="absolute inset-y-1 w-[2px] bg-sky-500/90" style={{ left: `${startLeft}%` }} />
        <div className="absolute inset-y-1 w-[2px] bg-rose-500/90" style={{ left: `${endLeft}%` }} />
        {hoverLeft !== null ? (
          <div
            className="absolute inset-y-3 w-px border-l border-dashed border-neutral-400/70"
            style={{ left: `${hoverLeft}%` }}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>开始：{formatTime(startS)}</span>
        <span>播放头：{formatTime(currentTime)}</span>
        <span>结束：{formatTime(endS)}</span>
        <span>视图：{formatTime(safeViewStartS)} - {formatTime(viewEndS)}</span>
        <span>{hoverTime === null ? "悬停时间：-" : `悬停时间：${formatTime(hoverTime)}`}</span>
      </div>
    </div>
  );
}
