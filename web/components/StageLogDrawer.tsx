"use client";

import type { StageName, StageRun, VerifyScores } from "@/lib/types";
import { STAGE_INFO } from "@/lib/stage-info";
import { STAGE_SHORT_LABEL, STAGE_STATUS_LABEL } from "@/lib/stage-labels";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { VerifyScoreBar } from "./VerifyScoreBar";

interface StageContext {
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  skipped?: boolean;
  reason?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  chunkId: string;
  stage: StageName;
  stageRun: StageRun | undefined;
  log: string;
  logLoading: boolean;
  logError: string | null;
  context: StageContext | null;
  onRetry: (cascade: boolean) => void;
  retrying?: boolean;
}

function getTroubleshooting(stage: StageName, stageRun: StageRun | undefined, context: StageContext | null): string[] {
  const suggestions: string[] = [];
  const errorText = `${stageRun?.error ?? ""} ${context?.reason ?? ""}`.toLowerCase();

  if (stage === "p2") {
    suggestions.push("先确认 VoxCPM /healthz 为 200，且模型已经完成加载。");
    if (errorText.includes("reference") || errorText.includes("prompt")) {
      suggestions.push("检查本地参考音频或 Prompt 音频路径是否真实存在、是否可读。");
    }
  }
  if (stage === "p2v") {
    suggestions.push("先确认 WhisperX /readyz 为 200，再判断是服务不可用还是质量门槛未通过。");
    suggestions.push("如果是质量失败，先试听当前 take，再结合 ASR 回写决定重跑还是改稿。");
  }
  if (stage === "p5") {
    suggestions.push("确认当前 chunk 已有 selected take，且 WhisperX transcript 不为空。");
  }
  if (stage === "p6") {
    suggestions.push("确认所有 chunk 都已 verified，并且每个 chunk 都有 selected take 和字幕。");
  }
  if (stageRun?.stale) {
    suggestions.push("这条阶段结果已经过期，上游文本或 take 改过后，建议从当前阶段继续重跑。");
  }
  if (suggestions.length === 0) {
    suggestions.push("先看下面的请求参数、响应产物和日志，再决定是局部重跑还是人工处理。");
  }
  return suggestions;
}

function statusBadge(sr: StageRun | undefined) {
  const base = "text-[10px] font-mono uppercase px-1.5 py-0.5 rounded tracking-wide";
  const status = sr?.status ?? "pending";
  switch (status) {
    case "pending":
      return <span className={`${base} bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-400`}>{STAGE_STATUS_LABEL.pending}</span>;
    case "running":
      return <span className={`${base} bg-blue-500 text-white animate-pulse`}>{STAGE_STATUS_LABEL.running}</span>;
    case "ok":
      return <span className={`${base} bg-emerald-500 text-white`}>{STAGE_STATUS_LABEL.ok}</span>;
    case "failed":
      return <span className={`${base} bg-red-500 text-white`}>{STAGE_STATUS_LABEL.failed}</span>;
  }
}

export function StageLogDrawer({
  open,
  onClose,
  chunkId,
  stage,
  stageRun,
  log,
  logLoading,
  logError,
  context,
  onRetry,
  retrying = false,
}: Props) {
  const info = STAGE_INFO[stage];
  const troubleshooting = getTroubleshooting(stage, stageRun, context);
  const attempt = stageRun?.attempt ?? 0;
  const durationMs = stageRun?.durationMs;

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle className="sr-only">{STAGE_SHORT_LABEL[stage]} · {chunkId}</SheetTitle>
          <span className="font-mono text-xs text-neutral-700 dark:text-neutral-300">{chunkId}</span>
          <span className="text-neutral-300 dark:text-neutral-600">·</span>
          <span className="text-xs font-semibold">{STAGE_SHORT_LABEL[stage]}</span>
          <span className="ml-1">{statusBadge(stageRun)}</span>
          <SheetClose asChild>
            <button type="button" className="ml-auto w-7 h-7 inline-flex items-center justify-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400" title="关闭">
              ×
            </button>
          </SheetClose>
        </SheetHeader>

        <details className="border-b border-neutral-200 dark:border-neutral-700 text-xs shrink-0" open>
          <summary className="px-4 py-2 bg-neutral-50 dark:bg-neutral-800 cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 font-semibold flex items-center gap-1.5">
            <span className="text-neutral-400">i</span>
            <span>{info.title}</span>
          </summary>
          <div className="px-4 py-2.5 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 space-y-1.5">
            <p className="leading-relaxed">{info.description}</p>
            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] mt-2">
              <span className="text-neutral-400">输入</span>
              <span className="text-neutral-600 dark:text-neutral-300">{info.inputs}</span>
              <span className="text-neutral-400">输出</span>
              <span className="text-neutral-600 dark:text-neutral-300">{info.outputs}</span>
              <span className="text-neutral-400">常见失败</span>
              <span className="text-neutral-600 dark:text-neutral-300">{info.failure}</span>
            </div>
          </div>
        </details>

        {stageRun?.status === "failed" ? (
          <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 shrink-0">
            <div className="font-semibold mb-0.5">错误详情</div>
            <div className="font-mono whitespace-pre-wrap break-words">
              {stageRun.error || ((context as Record<string, unknown>)?.error as string | undefined) || "未知错误，请继续查看下方日志。"}
            </div>
          </div>
        ) : null}

        <div className="px-4 py-2.5 border-b border-neutral-200 bg-amber-50/70 text-xs text-amber-900 dark:border-neutral-700 dark:bg-amber-950/20 dark:text-amber-100 shrink-0">
          <div className="font-semibold mb-1">排查建议</div>
          <ul className="space-y-1 leading-relaxed">
            {troubleshooting.map((item) => <li key={item}>• {item}</li>)}
          </ul>
        </div>

        {stage === "p2v" && context?.response ? (() => {
          const response = context.response as Record<string, unknown>;
          const scores = response.scores as VerifyScores | undefined;
          const diagnosis = response.diagnosis as { verdict?: string; type?: string; detail?: string } | undefined;
          if (!scores) return null;
          const pass = scores.weightedScore >= 0.7;
          return (
            <div className={`px-4 py-2.5 border-b text-xs shrink-0 ${pass ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800" : "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800"}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="font-semibold text-neutral-700 dark:text-neutral-300">复核结果</span>
                <span className="font-mono font-bold text-neutral-600 dark:text-neutral-300">{scores.weightedScore.toFixed(2)}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${pass ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300" : "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300"}`}>
                  {pass ? "通过" : "待复核"}
                </span>
              </div>
              {diagnosis?.detail ? <div className="text-[11px] text-neutral-600 dark:text-neutral-400 mb-2">{diagnosis.detail}</div> : null}
              <VerifyScoreBar scores={scores} />
            </div>
          );
        })() : null}

        {logLoading ? (
          <div className="flex-1 flex items-center justify-center text-xs text-neutral-400">正在加载日志…</div>
        ) : logError ? (
          <div className="flex-1 flex items-center justify-center px-4 text-xs text-red-500">日志读取失败：{logError}</div>
        ) : log !== "" ? (
          <pre className="text-xs font-mono whitespace-pre-wrap p-4 overflow-auto flex-1 bg-neutral-50 dark:bg-neutral-800 dark:text-neutral-300">{log}</pre>
        ) : (
          <div className="flex-1 overflow-auto p-4 text-xs">
            {stageRun ? (
              <div className="space-y-2">
                <div className="text-neutral-500">阶段执行信息</div>
                <table className="text-[11px] w-full">
                  <tbody className="divide-y divide-neutral-100 dark:divide-neutral-700">
                    <tr><td className="py-1 text-neutral-400 w-24">状态</td><td className="py-1 font-mono">{STAGE_STATUS_LABEL[stageRun.status]}</td></tr>
                    <tr><td className="py-1 text-neutral-400">尝试次数</td><td className="py-1 font-mono">{stageRun.attempt}</td></tr>
                    {stageRun.startedAt ? <tr><td className="py-1 text-neutral-400">开始时间</td><td className="py-1 font-mono">{stageRun.startedAt}</td></tr> : null}
                    {stageRun.finishedAt ? <tr><td className="py-1 text-neutral-400">结束时间</td><td className="py-1 font-mono">{stageRun.finishedAt}</td></tr> : null}
                    {stageRun.durationMs != null ? <tr><td className="py-1 text-neutral-400">耗时</td><td className="py-1 font-mono">{stageRun.durationMs}ms</td></tr> : null}
                    {stageRun.stale ? <tr><td className="py-1 text-neutral-400">结果状态</td><td className="py-1 text-amber-600">上游已变更</td></tr> : null}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-neutral-400 text-center mt-8">暂无阶段信息</div>
            )}

            {context && !context.skipped ? (
              <div className="mt-4 space-y-3">
                {context.request ? (
                  <div>
                    <div className="text-neutral-500 font-semibold text-[11px] mb-1">请求参数</div>
                    <pre className="text-[10px] font-mono bg-neutral-100 dark:bg-neutral-800 rounded p-2 whitespace-pre-wrap overflow-auto max-h-40">
                      {JSON.stringify(context.request, null, 2)}
                    </pre>
                  </div>
                ) : null}
                {context.response ? (
                  <div>
                    <div className="text-neutral-500 dark:text-neutral-400 font-semibold text-[11px] mb-1">响应产物</div>
                    <pre className="text-[10px] font-mono bg-neutral-100 dark:bg-neutral-800 rounded p-2 whitespace-pre-wrap overflow-auto max-h-40">
                      {JSON.stringify(context.response, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            ) : null}

            {context?.skipped ? (
              <div className="mt-4 text-xs text-neutral-500">已跳过：{context.reason ?? "已有 selected take"}</div>
            ) : null}
          </div>
        )}

        <div className="border-t border-neutral-200 dark:border-neutral-700 px-4 py-3 shrink-0 flex items-center gap-3">
          <div className="text-[11px] text-neutral-400 dark:text-neutral-500 font-mono">
            attempt {attempt}{durationMs != null ? ` · ${durationMs}ms` : ""}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={() => onRetry(false)}
              disabled={retrying}
              className={`text-xs ${retrying ? "text-neutral-400 cursor-not-allowed" : "text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:underline"}`}
            >
              仅重跑{STAGE_SHORT_LABEL[stage]}
            </button>
            <button
              type="button"
              onClick={() => onRetry(true)}
              disabled={retrying}
              className={`px-3 py-1.5 text-xs rounded ${retrying ? "bg-neutral-200 dark:bg-neutral-700 text-neutral-400 cursor-not-allowed" : "bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200"}`}
            >
              {retrying ? "重跑中…" : `从${STAGE_SHORT_LABEL[stage]}继续重跑`}
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
