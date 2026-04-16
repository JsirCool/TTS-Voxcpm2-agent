"use client";

import { useEffect, useState } from "react";
import { getApiUrl } from "@/lib/api-client";
import { ScriptPreview } from "./ScriptPreview";

interface Props {
  episodeId: string;
  open: boolean;
  onClose: () => void;
}

export function ScriptPreviewDialog({ episodeId, open, onClose }: Props) {
  const [raw, setRaw] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch(`${getApiUrl()}/episodes/${episodeId}/script`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then(setRaw)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open, episodeId]);

  if (!open) return null;

  const parsedScript =
    raw && typeof raw === "object" && raw !== null && Array.isArray((raw as { segments?: unknown }).segments)
      ? (raw as {
          title?: string;
          description?: string;
          segments: Array<{ id: string | number; type?: string; topic?: string; text: string }>;
        })
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900 w-[600px] max-h-[70vh] flex flex-col">
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-700 flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold">脚本预览</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-neutral-400 hover:text-neutral-600 text-lg leading-none ml-2"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {loading && <p className="text-sm text-neutral-400">加载中...</p>}
          {error && <p className="text-sm text-red-500">加载失败: {error}</p>}

          {parsedScript ? (
            <ScriptPreview
              title={parsedScript.title}
              description={parsedScript.description}
              segments={parsedScript.segments}
            />
          ) : raw != null ? (
            <pre className="text-xs font-mono bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border border-neutral-200 dark:border-neutral-700 rounded p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed">
              {JSON.stringify(raw, null, 2)}
            </pre>
          ) : null}

        </div>

        <div className="px-4 py-3 border-t border-neutral-200 dark:border-neutral-700 flex justify-end gap-2 shrink-0">
          <a
            href={`${getApiUrl()}/episodes/${episodeId}/script`}
            download={`${episodeId}-script.json`}
            className="px-3 py-1.5 text-xs rounded border border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            下载 JSON
          </a>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
