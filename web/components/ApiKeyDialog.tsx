"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { getApiUrl } from "@/lib/api-client";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ServiceStatus {
  voxcpm: boolean;
  whisperx: boolean;
  voxcpm_url: string;
  whisperx_url: string;
  voxcpm_error?: string | null;
  whisperx_error?: string | null;
  error?: string | null;
}

const API = getApiUrl();

async function fetchStatus(): Promise<ServiceStatus> {
  const res = await fetch(`${API}/keys/status`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json();
}

export function ApiKeyDialog({ open, onClose }: Props) {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    fetchStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Local Services</DialogTitle>
          <DialogDescription>
            这个版本不再依赖 Fish Audio 或 Groq API Key。P2 走本地 VoxCPM，P2v 走本地 WhisperX。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-5 py-4">
          <ServiceCard
            title="VoxCPM Local TTS"
            healthy={status?.voxcpm ?? false}
            url={status?.voxcpm_url ?? "http://127.0.0.1:8877"}
            detail={status?.voxcpm_error ?? null}
            loading={loading}
          />
          <ServiceCard
            title="WhisperX Local ASR"
            healthy={status?.whisperx ?? false}
            url={status?.whisperx_url ?? "http://127.0.0.1:7860"}
            detail={status?.whisperx_error ?? null}
            loading={loading}
          />

          {error && (
            <p className="text-xs text-red-600 dark:text-red-400 break-all">
              状态读取失败：{error}
            </p>
          )}

          <div className="rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-3 py-2 text-xs text-neutral-600 dark:text-neutral-300 leading-relaxed">
            <div>建议先启动两个本地服务：</div>
            <div className="font-mono mt-1">VoxCPM: /voxcpm-svc/server.py</div>
            <div className="font-mono">WhisperX: /whisperx-svc/server.py</div>
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            关闭
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServiceCard({
  title,
  healthy,
  url,
  detail,
  loading,
}: {
  title: string;
  healthy: boolean;
  url: string;
  detail: string | null;
  loading: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div
          className={`h-2.5 w-2.5 rounded-full ${
            loading
              ? "bg-amber-400"
              : healthy
                ? "bg-emerald-500"
                : "bg-red-500"
          }`}
        />
        <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {title}
        </h3>
      </div>
      <div className="text-xs font-mono text-neutral-600 dark:text-neutral-300 break-all">
        {url}
      </div>
      <div className="text-xs text-neutral-500 dark:text-neutral-400">
        {loading ? "检测中..." : healthy ? "服务可用" : "服务未就绪"}
      </div>
      {!loading && detail && (
        <div className="text-xs text-red-600 dark:text-red-400 break-all">
          {detail}
        </div>
      )}
    </div>
  );
}
