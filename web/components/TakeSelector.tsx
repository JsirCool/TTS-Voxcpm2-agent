"use client";

import { useState } from "react";
import type { Take } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  takes: Take[];
  selectedTakeId: string | null;
  onPreview?: (takeId: string) => void;
  onUse?: (takeId: string) => void;
}

export function TakeSelector({
  takes,
  selectedTakeId,
  onPreview,
  onUse,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  if (takes.length <= 1) return null;

  const latestIndex = takes.length - 1;
  const visibleRows = expanded
    ? takes.map((take, index) => ({ take, index }))
    : [{ take: takes[latestIndex], index: latestIndex }];
  const hiddenCount = takes.length - visibleRows.length;
  const selectedTakeIndex = selectedTakeId
    ? takes.findIndex((take) => take.id === selectedTakeId)
    : -1;
  const selectedIsHidden = !expanded && selectedTakeIndex >= 0 && selectedTakeIndex !== latestIndex;

  return (
    <div className="mt-1.5 rounded border border-neutral-200 bg-neutral-50 p-1.5 text-[11px] dark:border-neutral-700 dark:bg-neutral-800">
      <div className="mb-1 flex items-center gap-1 px-1 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        <span>Take 历史 ({takes.length})</span>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-neutral-300 text-[8px] font-bold hover:border-neutral-500">
                ?
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>每次合成（P2）都会生成一个 Take。</p>
              <p className="mt-1">`▶` 可以试听某个 Take。</p>
              <p>“使用”会切换为当前采用版本，并继续后续阶段。</p>
              <p className="mt-1 text-neutral-400">默认只显示最新一条，旧记录可按需展开。</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="ml-auto flex items-center gap-2 normal-case">
          {selectedIsHidden ? (
            <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
              当前采用 #{selectedTakeIndex + 1}
            </span>
          ) : null}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            >
              展开 {hiddenCount} 条旧记录
            </button>
          ) : takes.length > 1 ? (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            >
              收起
            </button>
          ) : null}
        </div>
      </div>

      {visibleRows.map(({ take, index }) => {
        const isSelected = take.id === selectedTakeId;
        const isLatest = index === latestIndex;
        return (
          <div
            key={take.id}
            className={`flex items-center gap-2 rounded px-1.5 py-1 ${
              isSelected ? "border border-emerald-200 bg-white dark:border-emerald-800 dark:bg-neutral-900" : ""
            }`}
          >
            <span className="font-mono text-neutral-500">#{index + 1}</span>
            {!expanded && isLatest ? (
              <span className="text-[10px] text-blue-600 dark:text-blue-400">最新</span>
            ) : null}
            {isSelected ? (
              <span className="text-[10px] text-emerald-600">✓ 当前采用</span>
            ) : null}
            <span className="font-mono text-neutral-400">
              {take.durationS.toFixed(2)}s
            </span>
            <div className="ml-auto flex gap-1">
              <button
                type="button"
                onClick={() => onPreview?.(take.id)}
                className="rounded px-1.5 py-0.5 text-neutral-600 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
                title="试听"
              >
                ▶
              </button>
              {!isSelected ? (
                <button
                  type="button"
                  onClick={() => onUse?.(take.id)}
                  className="rounded bg-neutral-900 px-1.5 py-0.5 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
                >
                  使用
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
