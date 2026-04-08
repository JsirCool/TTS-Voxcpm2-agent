"use client";

import type { EpisodeSummary, EpisodeStatus } from "@/lib/types";

interface Props {
  episodes: EpisodeSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewEpisode: () => void;
}

const STATUS_DOT: Record<EpisodeStatus, string> = {
  done: "bg-emerald-500",
  running: "bg-blue-500 animate-pulse",
  ready: "bg-neutral-300",
  failed: "bg-red-500",
  empty: "bg-neutral-200",
};

export function EpisodeSidebar({
  episodes,
  selectedId,
  onSelect,
  onNewEpisode,
}: Props) {
  return (
    <aside className="w-56 border-r border-neutral-200 bg-white flex flex-col shrink-0">
      <div className="px-3 py-3 flex items-center justify-between border-b border-neutral-100">
        <span className="text-xs font-medium text-neutral-500 uppercase tracking-wide">
          Episodes
        </span>
        <button
          type="button"
          onClick={onNewEpisode}
          className="text-xs px-2 py-1 rounded hover:bg-neutral-100 text-neutral-600"
        >
          + New
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {episodes.map((ep) => {
          const sel = ep.id === selectedId;
          const dotClass = STATUS_DOT[ep.status] ?? "bg-neutral-300";
          const suffix =
            ep.status === "running"
              ? "⏵"
              : ep.status === "done"
                ? String(ep.chunkCount)
                : ep.status;
          const orphan = Boolean(ep.metadata?.scriptMissing);
          return (
            <button
              key={ep.id}
              type="button"
              onClick={() => onSelect(ep.id)}
              title={orphan ? "脚本缺失 (orphan):episodes/<id>.json 不存在" : ""}
              className={`w-full text-left px-2.5 py-2 rounded cursor-pointer flex items-center gap-2 mb-0.5 ${
                sel ? "bg-neutral-900 text-white" : "hover:bg-neutral-100"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`}
              />
              <span className={`font-medium text-sm ${orphan ? "italic opacity-70" : ""}`}>
                {ep.id}
              </span>
              {orphan ? (
                <span
                  className={`text-[10px] ${sel ? "text-red-300" : "text-red-500"}`}
                >
                  ⚠
                </span>
              ) : null}
              <span
                className={`ml-auto text-[11px] font-mono ${
                  sel ? "text-neutral-300" : "text-neutral-400"
                }`}
              >
                {suffix}
              </span>
            </button>
          );
        })}
      </div>
      <div className="p-3 border-t border-neutral-100 text-[11px] text-neutral-400 font-mono">
        {episodes.length} episodes
      </div>
    </aside>
  );
}
