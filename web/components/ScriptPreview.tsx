"use client";

import type { ScriptSegment } from "@/lib/types";
import { stripControlMarkers } from "@/lib/utils";

interface Props {
  title?: string;
  description?: string;
  segments: ScriptSegment[];
}

const TYPE_COLOR: Record<string, string> = {
  hook: "bg-amber-50 text-amber-700 border-amber-200",
  content: "bg-blue-50 text-blue-700 border-blue-200",
  cta: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

export function ScriptPreview({ title, description, segments }: Props) {
  const totalChars = segments.reduce((acc, s) => acc + s.text.length, 0);

  return (
    <div className="px-6 py-4 max-w-4xl">
      {/* Header */}
      <div className="mb-4 pb-4 border-b border-neutral-200">
        {title ? (
          <h3 className="text-base font-semibold text-neutral-900 mb-1">
            {title}
          </h3>
        ) : null}
        {description ? (
          <p className="text-xs text-neutral-500 leading-relaxed">{description}</p>
        ) : null}
        <div className="mt-2 flex items-center gap-3 text-[11px] text-neutral-400 font-mono">
          <span>{segments.length} segments</span>
          <span>·</span>
          <span>{totalChars} chars</span>
          <span>·</span>
          <span className="text-amber-600">未生成 — 点 Generate 开始 P1 切分</span>
        </div>
      </div>

      {/* Segments */}
      <div className="space-y-3">
        {segments.map((seg, i) => {
          const typeColor =
            (seg.type && TYPE_COLOR[seg.type]) ||
            "bg-neutral-50 text-neutral-600 border-neutral-200";
          const cleanText = stripControlMarkers(seg.text);
          return (
            <div
              key={i}
              className="border border-neutral-200 rounded-lg p-3 hover:border-neutral-300 transition-colors"
            >
              <div className="flex items-baseline gap-2 mb-2">
                <span className="font-mono text-[11px] text-neutral-500 w-6">
                  #{seg.id}
                </span>
                {seg.type ? (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${typeColor}`}
                  >
                    {seg.type}
                  </span>
                ) : null}
                {seg.topic ? (
                  <span className="text-xs text-neutral-600">{seg.topic}</span>
                ) : null}
                <span className="ml-auto text-[10px] text-neutral-400 font-mono">
                  {seg.text.length} chars
                </span>
              </div>
              <p className="text-sm text-neutral-700 leading-relaxed">
                {cleanText}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
