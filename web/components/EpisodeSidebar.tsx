"use client";

import { useState } from "react";
import type { EpisodeSummary, EpisodeStatus } from "@/lib/types";

interface Props {
  episodes: EpisodeSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewEpisode: () => void;
  onDelete?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onArchive?: (id: string) => void;
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
  onDelete,
  onDuplicate,
  onArchive,
}: Props) {
  const [menuId, setMenuId] = useState<string | null>(null);

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
              ? "..."
              : ep.status === "done"
                ? `${ep.doneCount}/${ep.chunkCount}`
                : ep.status;
          const showMenu = menuId === ep.id;
          return (
            <div key={ep.id} className="relative mb-0.5">
              <div
                className={`w-full text-left px-2.5 py-2 rounded cursor-pointer flex items-center gap-2 ${
                  sel ? "bg-neutral-900 text-white" : "hover:bg-neutral-100"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(ep.id)}
                  className="flex items-center gap-2 flex-1 min-w-0"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
                  <span className="font-medium text-sm truncate">{ep.title}</span>
                  <span className={`ml-auto text-[11px] font-mono ${sel ? "text-neutral-300" : "text-neutral-400"}`}>
                    {suffix}
                  </span>
                </button>
                {(onDelete || onDuplicate || onArchive) && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setMenuId(showMenu ? null : ep.id); }}
                    className={`w-5 h-5 text-[11px] rounded flex items-center justify-center shrink-0 ${
                      sel ? "hover:bg-white/20 text-neutral-300" : "hover:bg-neutral-200 text-neutral-400"
                    }`}
                  >
                    ⋯
                  </button>
                )}
              </div>
              {showMenu && (
                <div className="absolute right-1 top-full mt-0.5 w-32 bg-white border border-neutral-200 rounded-md shadow-lg z-20 py-1">
                  {onDuplicate && (
                    <button type="button" onClick={() => { setMenuId(null); onDuplicate(ep.id); }}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-100">
                      Duplicate
                    </button>
                  )}
                  {onArchive && (
                    <button type="button" onClick={() => { setMenuId(null); onArchive(ep.id); }}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-100">
                      Archive
                    </button>
                  )}
                  {onDelete && (
                    <button type="button" onClick={() => { setMenuId(null); onDelete(ep.id); }}
                      className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50">
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="p-3 border-t border-neutral-100 text-[11px] text-neutral-400 font-mono">
        {episodes.length} episodes
      </div>
    </aside>
  );
}
