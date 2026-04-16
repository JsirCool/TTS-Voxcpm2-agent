"use client";

import type { EpisodeStatus, StageName } from "@/lib/types";
import { STAGE_SHORT_LABEL } from "@/lib/stage-labels";

interface Props {
  status: EpisodeStatus;
  running: boolean;
  currentStage: StageName | null;
  totalChunks: number;
  lastLogLine?: string;
}

export function StageProgress({ status, running, currentStage, totalChunks, lastLogLine }: Props) {
  if (status === "empty") return null;

  let bg = "bg-neutral-50 dark:bg-neutral-800";
  let border = "border-neutral-200 dark:border-neutral-700";
  let icon = "●";
  let iconColor = "text-neutral-400 dark:text-neutral-500";
  let mainText = "还未开始运行";
  let detailText: string | null = null;
  let barColor = "bg-neutral-300 dark:bg-neutral-600";

  if (running || status === "running") {
    bg = "bg-blue-50 dark:bg-blue-900/20";
    border = "border-blue-200 dark:border-blue-800";
    icon = "◉";
    iconColor = "text-blue-600 animate-pulse";
    mainText = currentStage ? `当前阶段：${STAGE_SHORT_LABEL[currentStage]}` : "处理链运行中";
    detailText = "等待阶段回传最新进度…";
    barColor = "bg-blue-500";
  } else if (status === "failed") {
    bg = "bg-red-50 dark:bg-red-900/20";
    border = "border-red-200 dark:border-red-800";
    icon = "!";
    iconColor = "text-red-600";
    mainText = currentStage ? `运行失败：${STAGE_SHORT_LABEL[currentStage]}` : "运行失败";
    detailText = lastLogLine?.trim() || null;
    barColor = "bg-red-500";
  } else if (status === "done") {
    bg = "bg-emerald-50 dark:bg-emerald-900/20";
    border = "border-emerald-200 dark:border-emerald-800";
    icon = "✓";
    iconColor = "text-emerald-600";
    mainText = `已完成 · ${totalChunks} 个 chunk`;
    detailText = currentStage ? `最后阶段：${STAGE_SHORT_LABEL[currentStage]}` : null;
    barColor = "bg-emerald-500";
  } else if (status === "ready") {
    mainText = `已就绪 · ${totalChunks} 个 chunk`;
    detailText = "可以开始配音、复核和出字。";
  }

  return (
    <div className={`px-6 py-2.5 border-b ${border} ${bg} flex items-center gap-3`}>
      <span className={`text-lg leading-none ${iconColor}`}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{mainText}</span>
          {detailText ? <span className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{detailText}</span> : null}
        </div>
        {(running || status === "running") ? (
          <div className="mt-1.5 h-1 bg-neutral-200 dark:bg-neutral-700 rounded-full overflow-hidden">
            <div className={`h-full ${barColor} animate-pulse`} style={{ width: "30%" }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
