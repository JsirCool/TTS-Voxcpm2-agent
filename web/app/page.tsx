"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { Moon, Server, Sun } from "lucide-react";
import { toast } from "sonner";
import { getApiUrl } from "@/lib/api-client";
import { useEpisodes, useEpisode, useEpisodeLogs, getAudioUrl, exportEpisode as exportEpisodeToLocal } from "@/lib/hooks";
import { STAGE_SHORT_LABEL } from "@/lib/stage-labels";
import type { Episode, StageName } from "@/lib/types";
import { useHarnessStore } from "@/lib/store";
import { useConfirm } from "@/hooks/useConfirm";
import { usePrompt } from "@/hooks/usePrompt";
import { useAction } from "@/hooks/useAction";
import { useTheme } from "@/components/Providers";
import { ApiKeyDialog } from "@/components/ApiKeyDialog";
import { ChunksTable } from "@/components/ChunksTable";
import type { ChunkFilterMode } from "@/components/ChunksTable";
import { ContinuousPlayBar } from "@/components/ContinuousPlayBar";
import { EditBanner } from "@/components/EditBanner";
import { EpisodeHeader } from "@/components/EpisodeHeader";
import { EpisodeSidebar } from "@/components/EpisodeSidebar";
import { EpisodeStageBar } from "@/components/EpisodeStageBar";
import { HelpDialog } from "@/components/HelpDialog";
import { LogViewer } from "@/components/LogViewer";
import { NewEpisodeDialog } from "@/components/NewEpisodeDialog";
import { ReviewWorkbench } from "@/components/ReviewWorkbench";
import { ScriptPreviewDialog } from "@/components/ScriptPreviewDialog";
import { StageLogDrawer } from "@/components/StageLogDrawer";
import { StageProgress } from "@/components/StageProgress";
import { TtsConfigBar } from "@/components/TtsConfigBar";

export default function Page() {
  const store = useHarnessStore();
  const [mounted, setMounted] = useState(false);
  const [newEpOpen, setNewEpOpen] = useState(false);
  const [scriptPreviewOpen, setScriptPreviewOpen] = useState(false);
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [synthesizingCid, setSynthesizingCid] = useState<string | null>(null);
  const [chunkFilterMode, setChunkFilterMode] = useState<ChunkFilterMode>("all");

  useEffect(() => {
    const savedId = localStorage.getItem("tts-harness:selectedEpisode");
    if (savedId) store.selectEpisode(savedId);
    const savedCollapsed = localStorage.getItem("tts-harness:sidebarCollapsed") === "true";
    if (savedCollapsed) store.setSidebarCollapsed(true);
    setMounted(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedId = mounted ? store.selectedId : null;
  const { data: episodes, error: episodesError, mutate: mutateList } = useEpisodes();
  const { data: episode, error: episodeError, mutate: mutateDetail } = useEpisode(selectedId);
  const { data: logLines, error: logsError } = useEpisodeLogs(selectedId);

  const running = episode?.status === "running";
  const runningStage = running
    ? episode?.chunks.find((chunk) => chunk.stageRuns.some((stageRun) => stageRun.status === "running"))
      ?.stageRuns.find((stageRun) => stageRun.status === "running")?.stage ?? null
    : null;
  const failedCount = episode?.chunks.filter((chunk) =>
    chunk.status === "failed" || chunk.stageRuns.some((stageRun) => stageRun.status === "failed"),
  ).length ?? 0;
  const reviewCount = episode?.chunks.filter((chunk) => chunk.status === "needs_review").length ?? 0;
  const dirtyCount = store.dirtyCount();
  const stagedChunkCount = Object.keys(store.edits).length;
  const lastRunId = typeof episode?.metadata?.lastRunId === "string" ? episode.metadata.lastRunId : null;
  const sidebarCollapsed = store.sidebarCollapsed;

  const playableIds = (episode?.chunks ?? [])
    .filter((chunk) => chunk.status === "synth_done" || chunk.status === "verified" || chunk.status === "needs_review")
    .map((chunk) => chunk.id);
  useEffect(() => {
    store.setChunkPlayOrder(playableIds);
  }, [playableIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const [confirmAction, ConfirmDialog] = useConfirm();
  const [promptAction, PromptDialog] = usePrompt();

  const [execRun, runPending] = useAction(
    useCallback(async (mode: string) => {
      await store.runEpisode(mode);
      await mutateDetail();
      await mutateList();
    }, [mutateDetail, mutateList, store]),
    { errorPrefix: "运行失败" },
  );

  const [execCreate] = useAction(
    useCallback(async (id: string, file: File, options?: { title?: string; config?: Record<string, unknown> }) => {
      await store.createEpisode(id, file, options);
      await mutateList();
      store.selectEpisode(id);
      setNewEpOpen(false);
    }, [mutateList, store]),
    { errorPrefix: "创建失败" },
  );

  const [execUseTake] = useAction(
    useCallback(async (cid: string, takeId: string) => {
      if (!episode) return;
      await store.finalizeTake(episode.id, cid, takeId);
      await mutateDetail();
    }, [episode, mutateDetail, store]),
    { errorPrefix: "选定 take 失败" },
  );

  const [execDelete] = useAction(
    useCallback(async (id: string) => {
      await store.deleteEpisode(id);
      await mutateList();
    }, [mutateList, store]),
    { errorPrefix: "删除失败" },
  );

  const [execDuplicate] = useAction(
    useCallback(async (id: string, newId: string) => {
      await store.duplicateEpisode(id, newId);
      await mutateList();
    }, [mutateList, store]),
    { errorPrefix: "复制失败" },
  );

  const [execArchive] = useAction(
    useCallback(async (id: string) => {
      await store.archiveEpisode(id);
      await mutateList();
    }, [mutateList, store]),
    { errorPrefix: "归档失败" },
  );

  const [execCancel, cancelPending] = useAction(
    useCallback(async () => {
      if (!episode) return;
      const response = await fetch(`${getApiUrl()}/episodes/${episode.id}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      await mutateDetail();
      await mutateList();
    }, [episode, mutateDetail, mutateList]),
    { errorPrefix: "取消失败" },
  );

  const [execRetry, retrying] = useAction(
    useCallback(async (cascade: boolean) => {
      if (!store.selectedId || !store.drawerOpen) return;
      await store.retryChunk(store.selectedId, store.drawerOpen.cid, store.drawerOpen.stage, cascade);
      store.closeDrawer();
    }, [store]),
    { errorPrefix: "重试失败" },
  );

  const [execStageRetry] = useAction(
    useCallback(async (stage: StageName) => {
      if (!episode) return;
      const failed = episode.chunks.filter((chunk) => chunk.stageRuns.find((stageRun) => stageRun.stage === stage)?.status === "failed");
      if (!failed.length) return;
      const ok = await confirmAction(`重跑 ${failed.length} 个失败的“${STAGE_SHORT_LABEL[stage]}”？`);
      if (!ok) return;
      for (const chunk of failed) {
        await store.retryChunk(episode.id, chunk.id, stage, true);
      }
    }, [confirmAction, episode, store]),
    { errorPrefix: "批量重跑失败" },
  );

  const [execApply] = useAction(
    useCallback(async () => {
      if (!episode) return;
      await store.applyEdits(episode.id);
      await mutateDetail();
    }, [episode, mutateDetail, store]),
    { errorPrefix: "应用编辑失败" },
  );

  const [execExportLocal] = useAction(
    useCallback(async () => {
      if (!episode) return;
      const directory = await promptAction("导出到哪个本地目录？", {
        defaultValue: "E:\\VC\\remotion-assets",
      });
      if (!directory) return;
      await exportEpisodeToLocal(episode.id, directory);
      toast.success("已导出到本地目录", { description: directory });
    }, [episode, promptAction]),
    { errorPrefix: "导出到本地目录失败" },
  );

  const [execSynthesize] = useAction(
    useCallback(async (cid: string) => {
      if (!episode) return;
      setSynthesizingCid(cid);
      try {
        await store.retryChunk(episode.id, cid, "p2", false);
        await mutateDetail();
        store.togglePlay(cid);
      } finally {
        setSynthesizingCid(null);
      }
    }, [episode, mutateDetail, store]),
    { errorPrefix: "配音失败" },
  );

  const [execQuickRetry] = useAction(
    useCallback(async (cid: string, stage: StageName) => {
      if (!episode) return;
      setSynthesizingCid(cid);
      try {
        await store.retryChunk(episode.id, cid, stage, true);
      } finally {
        setSynthesizingCid(null);
      }
    }, [episode, store]),
    { errorPrefix: "快捷重跑失败" },
  );

  const [execBatchRetry] = useAction(
    useCallback(async (stage: StageName, chunkIds: string[]) => {
      if (!episode || chunkIds.length === 0) return;
      const ok = await confirmAction(`批量从“${STAGE_SHORT_LABEL[stage]}”重跑 ${chunkIds.length} 个 chunk？`);
      if (!ok) return;
      for (const cid of chunkIds) {
        await store.retryChunk(episode.id, cid, stage, true);
      }
    }, [confirmAction, episode, store]),
    { errorPrefix: "批量重跑失败" },
  );

  useEffect(() => {
    if (!episode?.chunks.length) return;
    const chunks = episode.chunks;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const current = store.playingChunkId;
      const index = current ? chunks.findIndex((chunk) => chunk.id === current) : 0;
      const safeIndex = index < 0 ? 0 : index;
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        const chunk = chunks[safeIndex];
        if (chunk) store.togglePlay(chunk.id);
      } else if (event.key === "j") {
        event.preventDefault();
        const next = Math.min(chunks.length - 1, safeIndex + 1);
        if (current) store.togglePlay(chunks[next]?.id ?? current);
      } else if (event.key === "k") {
        event.preventDefault();
        const previous = Math.max(0, safeIndex - 1);
        if (current) store.togglePlay(chunks[previous]?.id ?? current);
      } else if (event.key === "e") {
        event.preventDefault();
        const chunk = chunks[safeIndex];
        if (chunk) store.startEditing(chunk.id);
      } else if (event.key === "Escape") {
        if (store.editing) store.cancelEditing();
        else if (store.drawerOpen) store.closeDrawer();
        else if (store.playingChunkId) store.togglePlay(store.playingChunkId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [episode?.chunks, store]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const handler = (value: MediaQueryListEvent | MediaQueryList) => {
      if (value.matches) store.setSidebarCollapsed(true);
    };
    handler(mediaQuery);
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function ThemeToggle() {
    const { resolvedTheme, setTheme } = useTheme();
    return (
      <button
        type="button"
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
        title="切换深浅色"
      >
        {resolvedTheme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      </button>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 overflow-hidden">
      <header className="h-12 border-b border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 flex items-center px-4 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-neutral-900 dark:bg-white flex items-center justify-center text-white dark:text-neutral-900 text-xs font-bold">T</div>
          <h1 className="font-semibold text-sm">TTS Harness 本地工作台</h1>
          <span className="text-xs text-neutral-400 dark:text-neutral-500 ml-1">v2</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setApiKeyOpen(true)}
            title="本地服务状态"
            className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
          >
            <Server size={14} />
          </button>
          <ThemeToggle />
          <button
            type="button"
            onClick={() => store.setHelpOpen(true)}
            title="使用说明"
            className="w-6 h-6 rounded-full border border-neutral-300 dark:border-neutral-600 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-semibold"
          >
            ?
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <EpisodeSidebar
          episodes={episodes ?? []}
          selectedId={selectedId}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => store.setSidebarCollapsed(!sidebarCollapsed)}
          onSelect={store.selectEpisode}
          onNewEpisode={() => setNewEpOpen(true)}
          error={episodesError ?? null}
          onDelete={async (id) => {
            const ok = await confirmAction(`确认删除 ${id}？`, { destructive: true });
            if (ok) await execDelete(id);
          }}
          onDuplicate={async (id) => {
            const newId = await promptAction(`复制 ${id} 到新 ID：`, { defaultValue: `${id}-copy` });
            if (newId) await execDuplicate(id, newId);
          }}
          onArchive={async (id) => {
            const ok = await confirmAction(`归档 ${id}？`);
            if (ok) await execArchive(id);
          }}
        />

        <main className="flex-1 min-w-0 flex flex-col overflow-hidden bg-neutral-50 dark:bg-neutral-900">
          {episode ? (
            <>
              <EpisodeHeader
                episode={episode}
                running={running}
                runPending={runPending}
                onRun={execRun}
                onCancel={execCancel}
                cancelPending={cancelPending}
                onViewScript={() => setScriptPreviewOpen(true)}
                onExportLocal={execExportLocal}
                failedCount={failedCount}
                reviewCount={reviewCount}
                stagedChunkCount={stagedChunkCount}
                lastRunId={lastRunId}
              />
              <TtsConfigBar
                episodeId={episode.id}
                config={episode.config}
                onConfigSaved={() => mutateDetail()}
                onUpdateConfig={store.updateConfig}
              />
              <StageProgress
                status={episode.status}
                running={running}
                currentStage={runningStage}
                totalChunks={episode.chunks.length}
              />
              {episode.chunks.length > 0 ? (
                <EpisodeStageBar chunks={episode.chunks} onStageRetry={execStageRetry} />
              ) : null}
              <EditBanner
                ttsCount={dirtyCount.tts}
                subCount={dirtyCount.sub}
                onApply={execApply}
                onDiscard={store.discardEdits}
              />
              <ReviewWorkbench
                chunks={episode.chunks}
                stagedChunkCount={stagedChunkCount}
                filterMode={chunkFilterMode}
                onFilterModeChange={setChunkFilterMode}
                onBatchRetry={execBatchRetry}
                onApplyStaged={execApply}
              />

              <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-neutral-900">
                {episode.chunks.length === 0 ? (
                  <div className="px-6 py-12 text-center text-sm text-neutral-400 dark:text-neutral-500">
                    还没有切出 chunk。先点击上方“切稿”开始第一步。
                  </div>
                ) : (
                  <>
                    <div className="px-6 py-2 bg-white dark:bg-neutral-900 border-b border-neutral-100 dark:border-neutral-700 flex items-center z-10 shrink-0">
                      <h3 className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">Chunk 列表</h3>
                      <span className="ml-2 text-[11px] text-neutral-400 dark:text-neutral-500">{episode.chunks.length} 条</span>
                      <div className="ml-auto">
                        <ContinuousPlayBar />
                      </div>
                    </div>
                    <ChunksTable
                      episodeId={episode.id}
                      chunks={episode.chunks}
                      filterMode={chunkFilterMode}
                      onFilterModeChange={setChunkFilterMode}
                      onStageClick={(cid, stage) => store.openDrawer(cid, stage)}
                      onPreviewTake={(_cid, takeId) => {
                        const chunk = episode.chunks.find((item) => item.takes.find((take) => take.id === takeId));
                        const take = chunk?.takes.find((item) => item.id === takeId);
                        if (take) store.previewTake(take.audioUri);
                      }}
                      onUseTake={execUseTake}
                      onSynthesize={execSynthesize}
                      onQuickRetry={execQuickRetry}
                      synthesizingCid={synthesizingCid}
                      getAudioUrl={getAudioUrl}
                    />
                  </>
                )}
              </div>
              <LogViewer log={logLines ?? []} error={logsError ?? null} />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
              {episodeError ? (
                <div className="text-center">
                  <div className="text-red-500 mb-2">加载 Episode 失败</div>
                  <div className="text-xs text-red-400 font-mono max-w-md break-all">{episodeError.message || String(episodeError)}</div>
                  <button
                    type="button"
                    onClick={() => mutateDetail()}
                    className="mt-3 text-xs px-3 py-1 rounded border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    重试
                  </button>
                </div>
              ) : selectedId ? (
                <div className="text-neutral-400">加载中…</div>
              ) : (
                "先从左侧选择一个 episode"
              )}
            </div>
          )}
        </main>
      </div>

      <NewEpisodeDialog open={newEpOpen} onClose={() => setNewEpOpen(false)} onCreate={execCreate} />
      <HelpDialog open={store.helpOpen} onClose={() => store.setHelpOpen(false)} />
      <ApiKeyDialog open={apiKeyOpen} onClose={() => setApiKeyOpen(false)} />
      {selectedId ? (
        <ScriptPreviewDialog episodeId={selectedId} open={scriptPreviewOpen} onClose={() => setScriptPreviewOpen(false)} />
      ) : null}

      {ConfirmDialog}
      {PromptDialog}

      {store.drawerOpen && store.selectedId && episode ? (
        <DrawerWithContext
          episodeId={store.selectedId}
          episode={episode}
          drawerOpen={store.drawerOpen}
          onClose={store.closeDrawer}
          onRetry={execRetry}
          retrying={retrying}
        />
      ) : null}
    </div>
  );
}

function DrawerWithContext({
  episodeId,
  episode,
  drawerOpen,
  onClose,
  onRetry,
  retrying = false,
}: {
  episodeId: string;
  episode: Episode;
  drawerOpen: { cid: string; stage: StageName };
  onClose: () => void;
  onRetry: (cascade: boolean) => Promise<void>;
  retrying?: boolean;
}) {
  const { data: ctxData } = useSWR(
    `api:stage-context:${episodeId}:${drawerOpen.cid}:${drawerOpen.stage}`,
    async () => {
      const response = await fetch(
        `${getApiUrl()}/episodes/${encodeURIComponent(episodeId)}/chunks/${encodeURIComponent(drawerOpen.cid)}/stage-context?stage=${encodeURIComponent(drawerOpen.stage)}`,
      );
      if (!response.ok) return null;
      const data = await response.json();
      return data.found ? data.payload : null;
    },
  );

  const chunk = episode.chunks.find((item) => item.id === drawerOpen.cid);
  const stageRun = chunk?.stageRuns.find((stage) => stage.stage === drawerOpen.stage);

  return (
    <StageLogDrawer
      open
      onClose={onClose}
      chunkId={drawerOpen.cid}
      stage={drawerOpen.stage}
      stageRun={stageRun}
      log=""
      logLoading={false}
      logError={null}
      context={ctxData ?? null}
      onRetry={onRetry}
      retrying={retrying}
    />
  );
}
