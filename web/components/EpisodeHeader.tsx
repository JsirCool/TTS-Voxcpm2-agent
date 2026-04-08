"use client";

import { useEffect, useRef, useState } from "react";
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

interface ConfirmConfig {
  variant: "blue" | "amber" | "red";
  label: string;
  title: string;
  body: string;
  action: string;
}

function getRunConfirm(status: EpisodeStatus): ConfirmConfig {
  switch (status) {
    case "ready":
    case "empty":
      return {
        variant: "blue",
        label: "▶ Generate",
        title: "首次生成",
        body: "调 Fish TTS 合成全部 chunks,再走 P3 转写 + P5/P6 拼接。整集大约 5-10 分钟。",
        action: "开始生成",
      };
    case "failed":
      return {
        variant: "amber",
        label: "↻ Retry",
        title: "重试上次失败的 pipeline",
        body: "上次 pipeline 退出非 0。重试会从 P1 重新开始,已生成的 chunks 会按 status 跳过。建议先查 run.log。",
        action: "重试",
      };
    case "done":
      return {
        variant: "red",
        label: "⟲ Re-run",
        title: "重跑已完成的 episode",
        body: "整集已 done。重跑会重新合成所有 chunks(Fish TTS 非确定性,音质可能波动)。如果只是想改某几个 chunk,直接 ✎ 编辑后 Apply All 即可。确定要全集重跑?",
        action: "我确定,全集重跑",
      };
    case "running":
    default:
      return {
        variant: "blue",
        label: "▶ Run",
        title: "",
        body: "",
        action: "",
      };
  }
}

export function EpisodeHeader({
  episode,
  running,
  currentStage,
  onRun,
  onExport,
}: Props) {
  const badge = STATUS_BADGE[episode.status] ?? STATUS_BADGE.ready;
  const scriptMissing = Boolean(episode.metadata?.scriptMissing);
  const runDisabled = running || scriptMissing;
  const exportDisabled = episode.status !== "done";

  const confirm = scriptMissing
    ? {
        variant: "red" as const,
        label: "▶ Run",
        title: "脚本缺失,无法运行",
        body: "这个 episode 在 .work/ 下有运行时数据,但 episodes/<id>.json 不存在(orphan)。要重新生成,需要先把 script.json 放回 episodes/ 目录。",
        action: "知道了",
      }
    : getRunConfirm(episode.status);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // 点外部关闭气泡
  useEffect(() => {
    if (!popoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [popoverOpen]);

  // ESC 关闭
  useEffect(() => {
    if (!popoverOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopoverOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [popoverOpen]);

  const handleRunClick = () => {
    if (runDisabled) return;
    setPopoverOpen(true);
  };

  const handleConfirm = () => {
    setPopoverOpen(false);
    onRun();
  };

  const variantClasses = {
    blue: {
      btn: "bg-neutral-900 text-white hover:bg-neutral-800",
      bar: "border-blue-200 bg-blue-50",
      icon: "text-blue-600",
      action: "bg-blue-600 text-white hover:bg-blue-700",
    },
    amber: {
      btn: "bg-amber-600 text-white hover:bg-amber-700",
      bar: "border-amber-200 bg-amber-50",
      icon: "text-amber-600",
      action: "bg-amber-600 text-white hover:bg-amber-700",
    },
    red: {
      btn: "bg-neutral-900 text-white hover:bg-neutral-800",
      bar: "border-red-200 bg-red-50",
      icon: "text-red-600",
      action: "bg-red-600 text-white hover:bg-red-700",
    },
  }[confirm.variant];

  return (
    <div className="px-6 py-3 border-b border-neutral-200 bg-white shrink-0">
      <div className="flex items-center gap-3 mb-2">
        <h2 className="text-lg font-semibold">{episode.id}</h2>
        <span
          className={`text-xs px-2 py-0.5 rounded-full border ${badge.bg} ${badge.fg} ${badge.br}`}
        >
          {badge.label}
        </span>
        {scriptMissing ? (
          <span
            className="text-xs px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-200"
            title="episodes/<id>.json 不存在,无法重跑 pipeline"
          >
            ⚠ orphan
          </span>
        ) : null}
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
        <div className="relative" ref={popoverRef}>
          <button
            type="button"
            onClick={handleRunClick}
            disabled={runDisabled}
            className={`px-3 py-1.5 text-sm rounded ${variantClasses.btn} ${
              runDisabled ? "opacity-50 cursor-not-allowed" : ""
            }`}
          >
            {confirm.label}
          </button>

          {popoverOpen && !runDisabled && (
            <div
              className={`absolute left-0 top-full mt-2 w-80 z-30 rounded-lg border shadow-lg ${variantClasses.bar}`}
            >
              <div className="p-3">
                <div className="flex items-start gap-2 mb-2">
                  <span className={`text-base ${variantClasses.icon}`}>
                    {confirm.variant === "red" ? "⚠" : "ⓘ"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-neutral-900">
                      {confirm.title}
                    </div>
                  </div>
                </div>
                <p className="text-xs text-neutral-700 leading-relaxed mb-3">
                  {confirm.body}
                </p>
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => setPopoverOpen(false)}
                    className="px-2.5 py-1 text-xs text-neutral-600 hover:bg-white/60 rounded"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    className={`px-3 py-1 text-xs rounded ${variantClasses.action}`}
                  >
                    {confirm.action}
                  </button>
                </div>
              </div>
              <div
                className={`absolute -top-1.5 left-4 w-3 h-3 rotate-45 border-t border-l ${variantClasses.bar}`}
              />
            </div>
          )}
        </div>
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
