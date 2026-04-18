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
  fetchMediaCapabilities,
  getDefaultMediaApplyMode,
  processCloneMedia,
  type MediaApplyMode,
  type MediaCapabilities,
  type MediaCleanupMode,
  type MediaProcessResult,
} from "@/lib/media-clone";
import { getTtsModeLabel } from "@/lib/tts-config";

interface Props {
  open: boolean;
  onClose: () => void;
  currentConfig: Record<string, unknown>;
  onApplyConfig: (config: Record<string, unknown>) => Promise<void>;
  onApplied?: () => void;
}

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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
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
  const [result, setResult] = useState<MediaProcessResult | null>(null);
  const [promptText, setPromptText] = useState("");

  const defaultApplyMode = useMemo(
    () => getDefaultMediaApplyMode(currentConfig),
    [currentConfig],
  );
  const parsedStartS = Number(startS);
  const parsedEndS = Number(endS);
  const isVideo = selectedFile?.type.startsWith("video/") ?? false;

  const resetDialogState = useCallback(() => {
    setSelectedFile(null);
    setPreviewUrl("");
    setCurrentTime(0);
    setMediaDuration(0);
    setStartS("0");
    setEndS("");
    setCleanupMode("light");
    setApplyMode(defaultApplyMode);
    setResult(null);
    setPromptText("");
  }, [defaultApplyMode]);

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
    if (selectedFile == null) {
      setPreviewUrl("");
      return;
    }
    const nextUrl = URL.createObjectURL(selectedFile);
    setPreviewUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [selectedFile]);

  useEffect(() => {
    setResult(null);
    if (applyMode !== "ultimate_cloning") {
      setPromptText("");
    }
  }, [applyMode, cleanupMode, endS, selectedFile, startS]);

  const handleMediaRef = useCallback((node: HTMLMediaElement | null) => {
    mediaRef.current = node;
  }, []);

  const canProcess = Boolean(selectedFile)
    && Boolean(capabilities?.ffmpeg)
    && Boolean(capabilities?.ffprobe)
    && Number.isFinite(parsedStartS)
    && Number.isFinite(parsedEndS)
    && parsedEndS > parsedStartS
    && (cleanupMode !== "vocal_isolate" || Boolean(capabilities?.demucs))
    && (applyMode !== "ultimate_cloning" || Boolean(capabilities?.whisperx));

  const handleFileChange = (file: File | null) => {
    setSelectedFile(file);
    setCurrentTime(0);
    setMediaDuration(0);
    setStartS("0");
    setEndS("");
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

  const handleProcess = async () => {
    if (!selectedFile || !canProcess) return;
    setProcessing(true);
    try {
      const processed = await processCloneMedia({
        file: selectedFile,
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
            从本地 mp4 / 音频裁剪片段、清理背景音，并一键回填到当前 Episode 的 VoxCPM 克隆配置。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[78vh] space-y-5 overflow-y-auto px-5 py-4">
          <section className="space-y-2">
            <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              本地能力
            </div>
            {loadingCapabilities ? (
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                正在检测 ffmpeg / Demucs / WhisperX...
              </div>
            ) : capabilities ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <CapabilityPill label="ffmpeg" ok={capabilities.ffmpeg} detail={capabilities.ffmpegError} />
                  <CapabilityPill label="ffprobe" ok={capabilities.ffprobe} detail={capabilities.ffprobeError} />
                  <CapabilityPill label="Demucs" ok={capabilities.demucs} detail={capabilities.demucsError} />
                  <CapabilityPill label="WhisperX" ok={capabilities.whisperx} detail={capabilities.whisperxError} />
                </div>
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  输出目录：<span className="font-mono">{capabilities.voiceSourceDir}</span>
                </div>
              </>
            ) : (
              <div className="text-xs text-red-500">能力检测失败，请确认本地 API 已启动。</div>
            )}
          </section>

          <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
            <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              1. 选择素材
            </div>
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/x-matroska,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a"
              onChange={(event) => handleFileChange(event.currentTarget.files?.[0] ?? null)}
              className="block w-full text-sm text-neutral-700 dark:text-neutral-200"
            />
            {selectedFile ? (
              <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                当前文件：<span className="font-mono">{selectedFile.name}</span>
              </div>
            ) : null}
          </section>

          <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
            <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              2. 预览与裁剪
            </div>
            {previewUrl ? (
              <div className="space-y-3">
                {isVideo ? (
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
                先选择一个本地 mp4 / 音频文件，才能预览和裁剪。
              </div>
            )}
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
              <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                3. 清理模式
              </div>
              <div className="space-y-2">
                <ChoiceCard
                  title="轻量稳定"
                  description="只依赖 ffmpeg，做抽音、单声道、重采样、响度规范和轻降噪，速度更快。"
                  active={cleanupMode === "light"}
                  onClick={() => setCleanupMode("light")}
                />
                <ChoiceCard
                  title="重度人声分离"
                  description={
                    capabilities?.demucs
                      ? "先做人声分离，再输出更干净的人声片段。"
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
                4. 套用模式
              </div>
              <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                当前 Episode 默认模式：<span className="font-semibold">{getTtsModeLabel(defaultApplyMode)}</span>
              </div>
              <div className="space-y-2">
                <ChoiceCard
                  title="可控克隆"
                  description="处理结果会写入 reference_audio_path，保留音色，并继续允许 Control Prompt 控风格。"
                  active={applyMode === "controllable_cloning"}
                  onClick={() => setApplyMode("controllable_cloning")}
                />
                <ChoiceCard
                  title="极致克隆"
                  description={
                    capabilities?.whisperx
                      ? "处理结果会写入 prompt_audio_path，并用 WhisperX 自动生成可编辑的 prompt_text。"
                      : `当前不可用：${capabilities?.whisperxError ?? "WhisperX 未就绪"}`
                  }
                  active={applyMode === "ultimate_cloning"}
                  disabled={!capabilities?.whisperx}
                  onClick={() => setApplyMode("ultimate_cloning")}
                />
              </div>
            </div>
          </section>

          <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                5. 处理结果
              </div>
              <button
                type="button"
                onClick={handleProcess}
                disabled={!canProcess || processing}
                className={`rounded px-3 py-1.5 text-sm font-medium ${
                  !canProcess || processing
                    ? "cursor-not-allowed bg-neutral-200 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400"
                    : "bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
                }`}
              >
                {processing ? "处理中..." : "处理素材"}
              </button>
            </div>

            {!canProcess ? (
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                需要先选择文件，并确保 ffmpeg / ffprobe 可用；重度人声分离需要 Demucs；极致克隆自动转写需要 WhisperX。
              </div>
            ) : null}

            {result ? (
              <div className="space-y-3 rounded border border-emerald-200 bg-emerald-50/70 p-3 text-sm dark:border-emerald-900/50 dark:bg-emerald-950/20">
                <div className="grid gap-2 text-[12px] text-neutral-700 dark:text-neutral-200">
                  <div>
                    输出路径：<span className="font-mono">{result.relativeAudioPath}</span>
                  </div>
                  <div>
                    裁剪后时长：<span className="font-mono">{result.durationS.toFixed(2)}s</span>
                  </div>
                  <div>
                    清理模式：<span className="font-semibold">{cleanupLabel(result.cleanupMode)}</span>
                  </div>
                  <div>
                    套用模式：<span className="font-semibold">{applyModeLabel(result.applyMode)}</span>
                  </div>
                </div>

                {applyMode === "ultimate_cloning" ? (
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">
                      自动转写的 prompt_text（可编辑）
                    </span>
                    <textarea
                      value={promptText}
                      onChange={(event) => setPromptText(event.currentTarget.value)}
                      rows={4}
                      className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
                    />
                  </label>
                ) : null}
              </div>
            ) : (
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                处理完成后，这里会显示输出的相对路径；极致克隆模式还会显示可编辑的自动转写文本。
              </div>
            )}
          </section>
        </div>

        <DialogFooter className="justify-between">
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
            套用时只会改当前 Episode，不会新建预设。
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              关闭
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!result || applying}
              className={`rounded px-3 py-1.5 text-sm font-medium ${
                !result || applying
                  ? "cursor-not-allowed bg-neutral-200 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400"
                  : "bg-blue-600 text-white hover:bg-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400"
              }`}
            >
              {applying ? "套用中..." : "套用到当前 Episode"}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
