"use client";

import type { Take } from "@/lib/types";

interface Props {
  takes: Take[];
  selectedTakeId: string | null;
  onPreview?: (takeId: string) => void;
  onUse?: (takeId: string) => void;
}

/**
 * Multi-take 切换器。只在 takes.length > 1 时渲染。
 * MVP 简化:list 风格,每 take 一行,显示 duration 和按钮。
 */
export function TakeSelector({
  takes,
  selectedTakeId,
  onPreview,
  onUse,
}: Props) {
  if (takes.length <= 1) return null;

  return (
    <div className="mt-1.5 border border-neutral-200 rounded bg-neutral-50 p-1.5 text-[11px]">
      <div className="text-[10px] uppercase tracking-wide text-neutral-400 mb-1 px-1">
        Takes ({takes.length})
      </div>
      {takes.map((t, i) => {
        const isSelected = t.id === selectedTakeId;
        return (
          <div
            key={t.id}
            className={`flex items-center gap-2 px-1.5 py-1 rounded ${
              isSelected ? "bg-white border border-emerald-200" : ""
            }`}
          >
            <span className="font-mono text-neutral-500">#{i + 1}</span>
            {isSelected ? (
              <span className="text-emerald-600 text-[10px]">✓ current</span>
            ) : null}
            <span className="font-mono text-neutral-400">
              {t.durationS.toFixed(2)}s
            </span>
            <div className="ml-auto flex gap-1">
              <button
                type="button"
                onClick={() => onPreview?.(t.id)}
                className="px-1.5 py-0.5 rounded hover:bg-neutral-200 text-neutral-600"
                title="Preview"
              >
                ▶
              </button>
              {!isSelected ? (
                <button
                  type="button"
                  onClick={() => onUse?.(t.id)}
                  className="px-1.5 py-0.5 rounded bg-neutral-900 text-white hover:bg-neutral-800"
                >
                  Use
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
