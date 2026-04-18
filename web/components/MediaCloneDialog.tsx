"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildConfigFromProcessedMedia,
  buildMediaPreviewUrl,
  fetchMediaCapabilities,
  getDefaultMediaApplyMode,
  importBilibiliMedia,
  processCloneMedia,
  type BilibiliDownloadTarget,
  type BilibiliImportResult,
  type MediaApplyMode,
  type MediaCapabilities,
  type MediaCleanupMode,
  type MediaProcessResult,
  type MediaSourceMode,
} from "@/lib/media-clone";

interface Props {
  open: boolean;
  onClose: () => void;
  currentConfig: Record<string, unknown>;
  onApplyConfig: (config: Record<string, unknown>) => Promise<void>;
  onApplied?: () => void;
}

const ACCEPTED_MEDIA_TYPES =
  "video/mp4,video/quicktime,video/x-matroska,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.00";
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${remaining.toFixed(2).padStart(5, "0")}`;
}

function cleanupLabel(mode: MediaCleanupMode): string {
  return mode === "vocal_isolate" ? "重度人声分离" : "轻量稳定";
}

function applyModeLabel(mode: MediaApplyMode): string {
  return mode === "ultimate_cloning" ? "极致克隆" : "可控克隆";
}

function sourceModeLabel(mode: MediaSourceMode): string {
  return mode === "bilibili_link" ? "B 站链接" : "本地文件";
}

function downloadTargetLabel(target: BilibiliDownloadTarget): string {
  return target === "video" ? "下载视频" : "仅下载音频";
}

function CapabilityPill({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail?: string | null;
}) {
  return (
    <span
      title={detail ?? ""}
      className={`rounded-full border px-2 py-0.5 text-[11px] ${
        ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"
          : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
      }`}
    >
      {label}: {ok ? "可用" : "不可用"}
    </span>
  );
}

function ChoiceCard({
  title,
  description,
  active,
  disabled,
  onClick,
}: {
  title: string;
  description: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border px-3 py-3 text-left transition ${
        disabled
          ? "cursor-not-allowed border-neutral-200 bg-neutral-100 text-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-500"
          : active
            ? "border-blue-500 bg-blue-50 shadow-sm dark:border-blue-400 dark:bg-blue-950/30"
            : "border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
      }`}
    >
      <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</div>
      <p className="mt-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
        {description}
      </p>
    </button>
  );
}

export function MediaCloneDialog({
  open,
  onClose,
  currentConfig,
  onApplyConfig,
  onApplied,
}: Props) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [sourceMode, setSourceMode] = useState<MediaSourceMode>("local_file");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [sourceRelativePath, setSourceRelativePath] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewKind, setPreviewKind] = useState<"video" | "audio" | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [startS, setStartS] = useState("0");
  const [endS, setEndS] = useState("");
  const [cleanupMode, setCleanupMode] = useState<MediaCleanupMode>("light");
  const [applyMode, setApplyMode] = useState<MediaApplyMode>("controllable_cloning");
  const [capabilities, setCapabilities] = useState<MediaCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<MediaProcessResult | null>(null);
  const [promptText, setPromptText] = useState("");
  const [bilibiliUrl, setBilibiliUrl] = useState("");
  const [downloadTarget, setDownloadTarget] = useState<BilibiliDownloadTarget>("video");
  const [importedMeta, setImportedMeta] = useState<BilibiliImportResult | null>(null);

  const defaultApplyMode = useMemo(
    () => getDefaultMediaApplyMode(currentConfig),
    [currentConfig],
  );

  const parsedStartS = Number(startS);
  const parsedEndS = Number(endS);
  const canProcess = (Boolean(selectedFile) || Boolean(sourceRelativePath))
    && Boolean(capabilities?.ffmpeg)
    && Boolean(capabilities?.ffprobe)
    && Number.isFinite(parsedStartS)
    && Number.isFinite(parsedEndS)
    && parsedEndS > parsedStartS
    && (cleanupMode !== "vocal_isolate" || Boolean(capabilities?.demucs))
    && (applyMode !== "ultimate_cloning" || Boolean(capabilities?.whisperx));

  const clearWorkingSource = useCallback(() => {
    setSelectedFile(null);
    setSourceRelativePath("");
    setPreviewUrl("");
    setPreviewKind(null);
    setImportedMeta(null);
    setCurrentTime(0);
    setMediaDuration(0);
    setStartS("0");
    setEndS("");
    setResult(null);
    setPromptText("");
  }, []);

  const resetDialogState = useCallback(() => {
    setSourceMode("local_file");
    clearWorkingSource();
    setCleanupMode("light");
    setApplyMode(defaultApplyMode);
    setBilibiliUrl("");
    setDownloadTarget("video");
  }, [clearWorkingSource, defaultApplyMode]);

  useEffect(() => {
    if (!open) return;
    resetDialogState();
    setLoadingCapabilities(true);
    void fetchMediaCapabilities()
      .then((data) => {
        setCapabilities(data);
        if (!data.demucs) {
          setCleanupMode("light");
        }
        if (!data.whisperx && defaultApplyMode === "ultimate_cloning") {
          setApplyMode("controllable_cloning");
        }
      })
      .catch((error) => {
        setCapabilities(null);
        toast.error("加载素材处理能力失败", {
          description: (error as Error).message,
        });
      })
      .finally(() => setLoadingCapabilities(false));
  }, [defaultApplyMode, open, resetDialogState]);

  useEffect(() => {
    if (sourceMode !== "local_file" || selectedFile == null) {
      return undefined;
    }
    const nextUrl = URL.createObjectURL(selectedFile);
    setPreviewUrl(nextUrl);
    setPreviewKind(selectedFile.type.startsWith("video/") ? "video" : "audio");
    return () => URL.revokeObjectURL(nextUrl);
  }, [selectedFile, sourceMode]);

  useEffect(() => {
    setResult(null);
    if (applyMode !== "ultimate_cloning") {
      setPromptText("");
    }
  }, [applyMode, cleanupMode, endS, selectedFile, sourceRelativePath, startS]);

  const handleMediaRef = useCallback((node: HTMLMediaElement | null) => {
    mediaRef.current = node;
  }, []);

  const handleSourceModeChange = (nextMode: MediaSourceMode) => {
    setSourceMode(nextMode);
    clearWorkingSource();
    setBilibiliUrl("");
  };

  const handleFileChange = (file: File | null) => {
    clearWorkingSource();
    setSelectedFile(file);
  };

  const handleLoadedMetadata = () => {
    const media = mediaRef.current;
    if (!media) return;
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    setMediaDuration(duration);
    setCurrentTime(media.currentTime || 0);
    if (!endS || Number(endS) <= 0 || Number(endS) > duration) {
      setEndS(duration > 0 ? duration.toFixed(3) : "");
    }
  };

  const handleImportBilibili = async () => {
    if (!bilibiliUrl.trim()) {
      toast.error("请先粘贴一个 B 站视频链接");
      return;
    }
    setImporting(true);
    try {
      const imported = await importBilibiliMedia({
        url: bilibiliUrl.trim(),
        downloadTarget,
      });
      clearWorkingSource();
      setImportedMeta(imported);
      setSourceRelativePath(imported.sourceRelativePath);
      setPreviewUrl(buildMediaPreviewUrl(imported.previewUrl));
      setPreviewKind(imported.mediaType);
      toast.success("B 站素材已导入", {
        description: `${downloadTargetLabel(imported.downloadTarget)} · ${imported.title}`,
      });
    } catch (error) {
      toast.error("B 站素材导入失败", {
        description: (error as Error).message,
      });
    } finally {
      setImporting(false);
    }
  };

  const handleProcess = async () => {
    if (!canProcess) return;
    setProcessing(true);
    try {
      const processed = await processCloneMedia({
        file: selectedFile,
        sourceRelativePath,
        startS: parsedStartS,
        endS: parsedEndS,
        cleanupMode,
        applyMode,
      });
      setResult(processed);
      setPromptText(processed.detectedText ?? "");
      toast.success("素材处理完成");
    } catch (error) {
      toast.error("素材处理失败", {
        description: (error as Error).message,
      });
    } finally {
      setProcessing(false);
    }
  };

  const handleApply = async () => {
    if (!result) return;
    if (applyMode === "ultimate_cloning" && !promptText.trim()) {
      toast.error("极致克隆需要 prompt_text，请先确认或补充转写文本");
      return;
    }
    setApplying(true);
    try {
      const nextConfig = buildConfigFromProcessedMedia(
        currentConfig,
        applyMode,
        result.relativeAudioPath,
        promptText,
      );
      await onApplyConfig(nextConfig);
      onApplied?.();
      toast.success("已套用到当前 Episode", {
        description: `模式：${applyModeLabel(applyMode)}`,
      });
      onClose();
    } catch (error) {
      toast.error("套用素材失败", {
        description: (error as Error).message,
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>素材处理</DialogTitle>
          <DialogDescription>
            支持本地文件和 B 站公开视频链接。下载或导入素材后，可继续预览、裁剪、清理并一键回填到当前 Episode 的 VoxCPM 克隆配置。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[78vh] space-y-5 overflow-y-auto px-5 py-4">
          <section className="space-y-2">
            <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              本地能力
            </div>
            {loadingCapabilities ? (
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                正在检测 ffmpeg / Demucs / WhisperX / B 站导入能力...
              </div>
            ) : capabilities ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <CapabilityPill label="ffmpeg" ok={capabilities.ffmpeg} detail={capabilities.ffmpegError} />
                  <CapabilityPill label="ffprobe" ok={capabilities.ffprobe} detail={capabilities.ffprobeError} />
                  <CapabilityPill label="Demucs" ok={capabilities.demucs} detail={capabilities.demucsError} />
                  <CapabilityPill label="WhisperX" ok={capabilities.whisperx} detail={capabilities.whisperxError} />
                  <CapabilityPill label="B 站导入" ok={capabilities.bilibiliEnabled} />
                </div>
                <div className="space-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                  <div>
                    输出目录：<span className="font-mono">{capabilities.voiceSourceDir}</span>
                  </div>
                  <div>
                    B 站导入范围：{capabilities.bilibiliPublicOnly ? "仅公开视频" : "支持登录扩展"}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-xs text-red-500">
                能力检测失败，请确认本地 API 已启动。
              </div>
            )}
          </section>

          <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
            <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              1. 选择素材来源
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <ChoiceCard
                title="本地文件"
                description="手动导入 mp4 / mov / mkv / mp3 / wav / m4a，然后在当前窗口里预览和裁剪。"
                active={sourceMode === "local_file"}
                onClick={() => handleSourceModeChange("local_file")}
              />
              <ChoiceCard
                title="B 站链接"
                description="直接粘贴公开视频链接，下载到本地缓存后自动进入预览与裁剪窗口。"
                active={sourceMode === "bilibili_link"}
                disabled={!capabilities?.bilibiliEnabled}
                onClick={() => handleSourceModeChange("bilibili_link")}
              />
            </div>
          </section>

          <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
            <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              2. 导入素材
            </div>

            {sourceMode === "local_file" ? (
              <div className="space-y-2">
                <input
                  type="file"
                  accept={ACCEPTED_MEDIA_TYPES}
                  onChange={(event) => handleFileChange(event.currentTarget.files?.[0] ?? null)}
                  className="block w-full text-sm text-neutral-700 dark:text-neutral-200"
                />
                {selectedFile ? (
                  <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    当前文件：<span className="font-mono">{selectedFile.name}</span>
                  </div>
                ) : (
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    请选择一个本地音视频文件。
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block space-y-1 text-xs text-neutral-600 dark:text-neutral-300">
                  <span>B 站视频链接</span>
                  <input
                    type="url"
                    value={bilibiliUrl}
                    onChange={(event) => setBilibiliUrl(event.currentTarget.value)}
                    placeholder="https://www.bilibili.com/video/BV..."
                    className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                  />
                </label>
                <div className="grid gap-3 md:grid-cols-2">
                  <ChoiceCard
                    title="下载视频"
                    description="保留画面，适合先预览内容再精确裁剪需要的片段。"
                    active={downloadTarget === "video"}
                    onClick={() => setDownloadTarget("video")}
                  />
                  <ChoiceCard
                    title="仅下载音频"
                    description="更快拿到音频素材，适合只想复刻音色、不需要画面预览的场景。"
                    active={downloadTarget === "audio"}
                    onClick={() => setDownloadTarget("audio")}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleImportBilibili}
                    disabled={importing || !bilibiliUrl.trim() || !capabilities?.bilibiliEnabled}
                    className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-neutral-300 dark:disabled:bg-neutral-700"
                  >
                    {importing ? "正在解析并下载..." : "解析并下载"}
                  </button>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    当前版本只支持公开可访问的普通 B 站视频链接，不支持登录态、会员或付费内容。
                  </span>
                </div>
                {importedMeta ? (
                  <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
                    <div className="font-medium">{importedMeta.title}</div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      <span>UP 主：{importedMeta.owner || "未知"}</span>
                      <span>来源：{downloadTargetLabel(importedMeta.downloadTarget)}</span>
                      <span>时长：{formatTime(importedMeta.durationS)}</span>
                      <span>缓存路径：{importedMeta.sourceRelativePath}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </section>

          <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
            <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              3. 预览与裁剪
            </div>
            {previewUrl ? (
              <div className="space-y-3">
                {previewKind === "video" ? (
                  <video
                    ref={handleMediaRef}
                    src={previewUrl}
                    controls
                    className="max-h-[260px] w-full rounded bg-black"
                    onLoadedMetadata={handleLoadedMetadata}
                    onTimeUpdate={() => setCurrentTime(mediaRef.current?.currentTime ?? 0)}
                  />
                ) : (
                  <audio
                    ref={handleMediaRef}
                    src={previewUrl}
                    controls
                    className="w-full"
                    onLoadedMetadata={handleLoadedMetadata}
                    onTimeUpdate={() => setCurrentTime(mediaRef.current?.currentTime ?? 0)}
                  />
                )}

                <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                  <span>
                    当前时间：<span className="font-mono">{formatTime(currentTime)}</span>
                  </span>
                  <span>
                    总时长：<span className="font-mono">{formatTime(mediaDuration)}</span>
                  </span>
                  <span>
                    来源：<span className="font-medium">{sourceModeLabel(sourceMode)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setStartS(currentTime.toFixed(3))}
                    className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
                  >
                    设为开始
                  </button>
                  <button
                    type="button"
                    onClick={() => setEndS(currentTime.toFixed(3))}
                    className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
                  >
                    设为结束
                  </button>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1 text-xs text-neutral-600 dark:text-neutral-300">
                    <span>开始时间（秒）</span>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={startS}
                      onChange={(event) => setStartS(event.currentTarget.value)}
                      className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                    />
                  </label>
                  <label className="space-y-1 text-xs text-neutral-600 dark:text-neutral-300">
                    <span>结束时间（秒）</span>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={endS}
                      onChange={(event) => setEndS(event.currentTarget.value)}
                      className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                    />
                  </label>
                </div>
              </div>
            ) : (
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                先导入一个本地文件或 B 站素材，才能预览和裁剪。
              </div>
            )}
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
              <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                4. 清理模式
              </div>
              <div className="space-y-2">
                <ChoiceCard
                  title="轻量稳定"
                  description="只依赖 ffmpeg，做抽音、单声道、重采样、响度规范和轻降噪，处理速度更快。"
                  active={cleanupMode === "light"}
                  onClick={() => setCleanupMode("light")}
                />
                <ChoiceCard
                  title="重度人声分离"
                  description={
                    capabilities?.demucs
                      ? "先做人声分离，再输出更干净的人声片段，更适合从复杂背景里提取音色。"
                      : `当前不可用：${capabilities?.demucsError ?? "需要先安装 Demucs"}`
                  }
                  active={cleanupMode === "vocal_isolate"}
                  disabled={!capabilities?.demucs}
                  onClick={() => setCleanupMode("vocal_isolate")}
                />
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
              <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                5. 套用模式
              </div>
              <div className="space-y-2">
                <ChoiceCard
                  title="可控克隆"
                  description="把处理后的素材写入 reference_audio_path，保留音色，同时保留当前集的其它稳定参数。"
                  active={applyMode === "controllable_cloning"}
                  onClick={() => setApplyMode("controllable_cloning")}
                />
                <ChoiceCard
                  title="极致克隆"
                  description={
                    capabilities?.whisperx
                      ? "把处理后的素材写入 prompt_audio_path，并用 WhisperX 自动生成可编辑的 prompt_text。"
                      : `当前不可用：${capabilities?.whisperxError ?? "需要先启动 WhisperX"}`
                  }
                  active={applyMode === "ultimate_cloning"}
                  disabled={!capabilities?.whisperx}
                  onClick={() => setApplyMode("ultimate_cloning")}
                />
              </div>
            </div>
          </section>

          <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  6. 处理并生成克隆素材
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  当前会按 <span className="font-medium">{cleanupLabel(cleanupMode)}</span> 处理，
                  并按 <span className="font-medium">{applyModeLabel(applyMode)}</span> 套用到当前 Episode。
                </div>
              </div>
              <button
                type="button"
                onClick={handleProcess}
                disabled={!canProcess || processing}
                className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-neutral-300 dark:disabled:bg-neutral-700"
              >
                {processing ? "处理中..." : "处理素材"}
              </button>
            </div>

            {result ? (
              <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
                <div className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
                  已生成可套用素材
                </div>
                <div className="grid gap-2 text-xs text-emerald-900 dark:text-emerald-100 md:grid-cols-2">
                  <div>输出路径：<span className="font-mono">{result.relativeAudioPath}</span></div>
                  <div>时长：<span className="font-mono">{formatTime(result.durationS)}</span></div>
                  <div>清理模式：{cleanupLabel(result.cleanupMode)}</div>
                  <div>套用模式：{applyModeLabel(result.applyMode)}</div>
                </div>
                {applyMode === "ultimate_cloning" ? (
                  <label className="block space-y-1 text-xs text-neutral-700 dark:text-neutral-200">
                    <span>自动生成的 prompt_text（可编辑后再套用）</span>
                    <textarea
                      value={promptText}
                      onChange={(event) => setPromptText(event.currentTarget.value)}
                      rows={4}
                      className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
                    />
                  </label>
                ) : (
                  <div className="text-xs text-neutral-600 dark:text-neutral-300">
                    该素材会作为 <span className="font-medium">reference_audio_path</span> 回填到当前 Episode。
                  </div>
                )}
              </div>
            ) : null}
          </section>
        </div>

        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-300 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!result || applying}
            className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-neutral-300 dark:disabled:bg-neutral-700"
          >
            {applying ? "正在套用..." : "套用到当前 Episode"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
