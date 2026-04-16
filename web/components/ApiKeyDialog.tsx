"use client";

import { useCallback, useEffect, useState } from "react";
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
  api: boolean;
  database: boolean;
  storage: boolean;
  voxcpm_url: string;
  whisperx_url: string;
  voxcpm_error?: string | null;
  whisperx_error?: string | null;
  databaseError?: string | null;
  storageError?: string | null;
  error?: string | null;
}

const API = getApiUrl();

async function fetchStatus(): Promise<ServiceStatus> {
  const [serviceRes, readyRes] = await Promise.all([
    fetch(`${API}/keys/status`, { credentials: "include" }),
    fetch(`${API}/readyz`, { credentials: "include" }),
  ]);
  if (!serviceRes.ok) {
    throw new Error(await serviceRes.text());
  }
  if (!readyRes.ok) {
    throw new Error(await readyRes.text());
  }
  const serviceData = await serviceRes.json();
  const readyData = await readyRes.json();
  return {
    ...serviceData,
    api: Boolean(readyData.api),
    database: Boolean(readyData.database),
    storage: Boolean(readyData.storage),
    databaseError: readyData.databaseError ?? null,
    storageError: readyData.storageError ?? null,
  };
}

export function ApiKeyDialog({ open, onClose }: Props) {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchStatus();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        await loadStatus();
      } catch {
        // loadStatus already updates local error state
      }
    })();
  }, [open, loadStatus]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>本地服务状态</DialogTitle>
          <DialogDescription>
            这个版本不再依赖 Fish Audio 或 Groq API Key。P2 调用本地 VoxCPM，P2v 调用本地 WhisperX。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-5 py-4">
          <ServiceCard
            title="Harness API"
            healthy={status?.api ?? false}
            url={API}
            detail={null}
            loading={loading}
          />
          <ServiceCard
            title="Postgres 数据库"
            healthy={status?.database ?? false}
            url="内部依赖"
            detail={status?.databaseError ?? null}
            loading={loading}
          />
          <ServiceCard
            title="MinIO 对象存储"
            healthy={status?.storage ?? false}
            url="内部依赖"
            detail={status?.storageError ?? null}
            loading={loading}
          />
          <ServiceCard
            title="VoxCPM 语音合成"
            healthy={status?.voxcpm ?? false}
            url={status?.voxcpm_url ?? "http://127.0.0.1:8877"}
            detail={status?.voxcpm_error ?? null}
            loading={loading}
          />
          <ServiceCard
            title="WhisperX 转写校验"
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
            <div>建议先确认两个本地服务都已启动：</div>
            <div className="font-mono mt-1">VoxCPM: /voxcpm-svc/server.py</div>
            <div className="font-mono">WhisperX: /whisperx-svc/server.py</div>
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => loadStatus()}
            disabled={loading}
            className="px-3 py-1.5 text-sm rounded border border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "检测中..." : "重新检测"}
          </button>
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
      <a
        href={url.startsWith("http") ? `${url.replace(/\/$/, "")}/healthz` : undefined}
        target="_blank"
        rel="noreferrer"
        className={`inline-flex text-[11px] ${url.startsWith("http") ? "text-blue-600 dark:text-blue-400 hover:underline" : "text-neutral-400 cursor-default"}`}
      >
        {url.startsWith("http") ? "打开 healthz" : "由 API 启动时统一检查"}
      </a>
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
