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
  buildNeutralTrialConfig,
  fetchMediaCapabilities,
  getDefaultMediaApplyMode,
  importBilibiliMedia,
  processCloneMedia,
  requestTrialSynthesis,
  resolveMediaSubtitles,
  type BilibiliDownloadTarget,
  type BilibiliImportResult,
  type MediaApplyMode,
  type MediaCapabilities,
  type MediaCleanupMode,
  type MediaProcessResult,
  type MediaSourceMode,
  type SubtitleCue,
  type SubtitleResolveResult,
  type TrialSynthesisResult,
} from "@/lib/media-clone";

interface Props {
  open: boolean;
  onClose: () => void;
  currentConfig: Record<string, unknown>;
  onApplyConfig: (config: Record<string, unknown>) => Promise<void>;
  onApplied?: () => void;
}

const ULTIMATE_CLONING_RECOMMENDED_MAX_SECONDS = 8;

type ApiError = Error & { code?: string; status?: number };

const ACCEPTED_MEDIA_TYPES =
  "video/mp4,video/quicktime,video/x-matroska,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.000";
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${remaining.toFixed(3).padStart(6, "0")}`;
}

function formatDurationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "未知时长";
  return `${seconds.toFixed(2)} 秒`;
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

function subtitleSourceLabel(sourceType: SubtitleResolveResult["sourceType"]): string {
  return sourceType === "bilibili_official" ? "B 站官方字幕" : "WhisperX 自动字幕";
}

function getNameFromFilename(value: string): string {
  const fileName = value.split(/[\\/]/).pop() ?? value;
  return fileName.replace(/\.[^.]+$/, "").trim();
}

function sanitizeAssetName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
}

function joinCueText(cues: SubtitleCue[], language: string): string {
  if (cues.length === 0) return "";
  if (language.startsWith("zh")) {
    return cues.map((cue) => cue.text.trim()).join("");
  }
  return cues.map((cue) => cue.text.trim()).join(" ").replace(/\s+/g, " ").trim();
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
  const cueRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const autoDowngradedSubtitleSourceRef = useRef<string | null>(null);

  const [sourceMode, setSourceMode] = useState<MediaSourceMode>("local_file");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [sourceRelativePath, setSourceRelativePath] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewKind, setPreviewKind] = useState<"video" | "audio" | null>(null);
  const [importedMeta, setImportedMeta] = useState<BilibiliImportResult | null>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [startS, setStartS] = useState("0");
  const [endS, setEndS] = useState("");
  const [assetName, setAssetName] = useState("");
  const [cleanupMode, setCleanupMode] = useState<MediaCleanupMode>("light");
  const [applyMode, setApplyMode] = useState<MediaApplyMode>("controllable_cloning");

  const [capabilities, setCapabilities] = useState<MediaCapabilities | null>(null);
  const [loadingCapabilities, setLoadingCapabilities] = useState(false);
  const [resolvingSubtitles, setResolvingSubtitles] = useState(false);
  const [subtitleNeedsWhisperx, setSubtitleNeedsWhisperx] = useState(false);
  const [subtitlePromptMessage, setSubtitlePromptMessage] = useState("");
  const [subtitleResult, setSubtitleResult] = useState<SubtitleResolveResult | null>(null);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<number | null>(null);

  const [processing, setProcessing] = useState(false);
  const [processResult, setProcessResult] = useState<MediaProcessResult | null>(null);
  const [promptText, setPromptText] = useState("");
  const [trialResult, setTrialResult] = useState<TrialSynthesisResult | null>(null);
  const [trialing, setTrialing] = useState(false);

  const [importing, setImporting] = useState(false);
  const [bilibiliUrl, setBilibiliUrl] = useState("");
  const [downloadTarget, setDownloadTarget] = useState<BilibiliDownloadTarget>("video");

  const defaultApplyMode = useMemo(
    () => getDefaultMediaApplyMode(currentConfig),
    [currentConfig],
  );

  const subtitleCues = subtitleResult?.cues ?? [];
  const rangeStartIndex = selectionStart === null ? null : Math.min(selectionStart, selectionEnd ?? selectionStart);
  const rangeEndIndex = selectionStart === null ? null : Math.max(selectionStart, selectionEnd ?? selectionStart);
  const selectedCues = useMemo(() => {
    if (rangeStartIndex === null || rangeEndIndex === null) return [] as SubtitleCue[];
    return subtitleCues.slice(rangeStartIndex, rangeEndIndex + 1);
  }, [rangeEndIndex, rangeStartIndex, subtitleCues]);
  const selectedText = useMemo(
    () => joinCueText(selectedCues, subtitleResult?.language ?? "zh"),
    [selectedCues, subtitleResult?.language],
  );
  const parsedStartS = Number(startS);
  const parsedEndS = Number(endS);
  const selectedDuration = useMemo(() => {
    if (!Number.isFinite(parsedStartS) || !Number.isFinite(parsedEndS)) return 0;
    return Math.max(0, parsedEndS - parsedStartS);
  }, [parsedEndS, parsedStartS]);

  const activeCueId = useMemo(() => {
    const activeCue = subtitleCues.find(
      (cue) => currentTime >= cue.startS && currentTime <= cue.endS,
    );
    return activeCue?.id ?? null;
  }, [currentTime, subtitleCues]);

  const hasSource = Boolean(selectedFile) || Boolean(sourceRelativePath);
  const canProcess = hasSource
    && Boolean(assetName.trim())
    && Number.isFinite(parsedStartS)
    && Number.isFinite(parsedEndS)
    && parsedEndS > parsedStartS
    && Boolean(capabilities?.ffmpeg)
    && Boolean(capabilities?.ffprobe)
    && (cleanupMode !== "vocal_isolate" || Boolean(capabilities?.demucs));
  const canApply = Boolean(processResult)
    && (applyMode !== "ultimate_cloning" || Boolean(promptText.trim()));

  const resetWorkingSource = useCallback(() => {
    setSelectedFile(null);
    setSourceRelativePath("");
    setPreviewUrl("");
    setPreviewKind(null);
    setImportedMeta(null);
    setCurrentTime(0);
    setMediaDuration(0);
    setStartS("0");
    setEndS("");
    setSubtitleResult(null);
    setSubtitleNeedsWhisperx(false);
    setSubtitlePromptMessage("");
    setSelectionStart(null);
    setSelectionEnd(null);
    setProcessResult(null);
    setPromptText("");
    setTrialResult(null);
    cueRefs.current = {};
  }, []);

  const resetDialogState = useCallback(() => {
    setSourceMode("local_file");
    resetWorkingSource();
    setAssetName("");
    setCleanupMode("light");
    setApplyMode(defaultApplyMode);
    setBilibiliUrl("");
    setDownloadTarget("video");
  }, [defaultApplyMode, resetWorkingSource]);

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

  const loadSubtitles = useCallback(async (allowWhisperx: boolean) => {
    if (!hasSource) return;
    setResolvingSubtitles(true);
    setSubtitleResult(null);
    setSubtitleNeedsWhisperx(false);
    setSubtitlePromptMessage("");
    setSelectionStart(null);
    setSelectionEnd(null);
    setProcessResult(null);
    setPromptText("");
    setTrialResult(null);

    if (allowWhisperx) {
      toast.info("WhisperX 正在自动转写字幕", {
        description: "转写过程可能会有点久，请稍等。",
      });
    }

    try {
      const result = await resolveMediaSubtitles({
        file: selectedFile,
        sourceRelativePath,
        allowWhisperx,
      });
      setSubtitleResult(result);
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.code === "subtitle_requires_whisperx") {
        setSubtitleNeedsWhisperx(true);
        setSubtitlePromptMessage(apiError.message);
      } else {
        setSubtitleResult(null);
        toast.error("生成字幕失败", {
          description: apiError.message,
        });
      }
    } finally {
      setResolvingSubtitles(false);
    }
  }, [hasSource, selectedFile, sourceRelativePath]);

  useEffect(() => {
    if (!hasSource) return;
    void loadSubtitles(false);
  }, [hasSource, loadSubtitles]);

  useEffect(() => {
    if (!subtitleResult) {
      autoDowngradedSubtitleSourceRef.current = null;
      return;
    }
    if (subtitleResult.sourceType !== "whisperx_generated") {
      autoDowngradedSubtitleSourceRef.current = null;
      return;
    }
    if (
      applyMode === "ultimate_cloning"
      && autoDowngradedSubtitleSourceRef.current !== subtitleResult.sourceType
    ) {
      autoDowngradedSubtitleSourceRef.current = subtitleResult.sourceType;
      setApplyMode("controllable_cloning");
      toast.warning("当前字幕来自 WhisperX 自动转写，已先切回可控克隆", {
        description: "极致克隆更依赖精确 prompt_text。若继续使用极致克隆，建议改选更短、更准确的样本。",
      });
    }
  }, [applyMode, subtitleResult]);

  useEffect(() => {
    if (!selectedText) return;
    setPromptText(selectedText);
  }, [selectedText]);

  useEffect(() => {
    if (rangeStartIndex === null || rangeEndIndex === null || selectedCues.length === 0) return;
    setStartS(selectedCues[0].startS.toFixed(3));
    setEndS(selectedCues[selectedCues.length - 1].endS.toFixed(3));
  }, [rangeEndIndex, rangeStartIndex, selectedCues]);

  useEffect(() => {
    if (!activeCueId) return;
    cueRefs.current[activeCueId]?.scrollIntoView({ block: "nearest" });
  }, [activeCueId]);

  const handleMediaRef = useCallback((node: HTMLMediaElement | null) => {
    mediaRef.current = node;
  }, []);

  const handleSourceModeChange = (nextMode: MediaSourceMode) => {
    setSourceMode(nextMode);
    resetWorkingSource();
    setAssetName("");
    setBilibiliUrl("");
  };

  const handleFileChange = (file: File | null) => {
    resetWorkingSource();
    setSelectedFile(file);
    setAssetName(file ? sanitizeAssetName(getNameFromFilename(file.name)) : "");
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

  const handleCueClick = (index: number) => {
    if (selectionStart === null || (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd)) {
      setSelectionStart(index);
      setSelectionEnd(index);
      return;
    }
    setSelectionEnd(index);
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
      resetWorkingSource();
      setImportedMeta(imported);
      setSourceRelativePath(imported.sourceRelativePath);
      setPreviewUrl(buildMediaPreviewUrl(imported.previewUrl));
      setPreviewKind(imported.mediaType);
      setAssetName(sanitizeAssetName(imported.owner ? `${imported.owner}-${imported.title}` : imported.title));
      setEndS(imported.durationS > 0 ? imported.durationS.toFixed(3) : "");
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

  const runTrialSynthesis = useCallback(async (
    processed: MediaProcessResult,
    nextPromptText: string,
  ) => {
    setTrialing(true);
    try {
      const trial = await requestTrialSynthesis({
        applyMode,
        assetRelativePath: processed.assetRelativePath,
        promptText: applyMode === "ultimate_cloning" ? nextPromptText : undefined,
        baseConfig: buildNeutralTrialConfig(currentConfig),
      });
      setTrialResult(trial);
      toast.success("固定试配音已生成");
    } catch (error) {
      setTrialResult(null);
      toast.error("生成固定试配音失败", {
        description: (error as Error).message,
      });
    } finally {
      setTrialing(false);
    }
  }, [applyMode, currentConfig]);

  const handleProcess = async () => {
    if (!canProcess) return;
    if (applyMode === "ultimate_cloning" && selectedDuration > ULTIMATE_CLONING_RECOMMENDED_MAX_SECONDS) {
      toast.error("当前样本过长，不建议直接用于极致克隆", {
        description: `极致克隆更适合 ${ULTIMATE_CLONING_RECOMMENDED_MAX_SECONDS} 秒以内的精确短样本。当前选段 ${selectedDuration.toFixed(2)} 秒，建议缩短后再试，或改用可控克隆。`,
      });
      return;
    }
    setProcessing(true);
    try {
      const processed = await processCloneMedia({
        file: selectedFile,
        sourceRelativePath,
        startS: parsedStartS,
        endS: parsedEndS,
        cleanupMode,
        applyMode,
        assetName: assetName.trim(),
        selectedText,
      });
      setProcessResult(processed);

      const nextPromptText =
        applyMode === "ultimate_cloning"
          ? (promptText.trim() || processed.selectedText || processed.detectedText || "").trim()
          : "";
      if (applyMode === "ultimate_cloning") {
        setPromptText(nextPromptText);
      }

      toast.success("素材处理完成");
      await runTrialSynthesis(processed, nextPromptText);
    } catch (error) {
      toast.error("素材处理失败", {
        description: (error as Error).message,
      });
    } finally {
      setProcessing(false);
    }
  };

  const handleApply = async () => {
    if (!processResult) return;
    if (applyMode === "ultimate_cloning" && !promptText.trim()) {
      toast.error("极致克隆需要 prompt_text，请先确认字幕文本");
      return;
    }
    if (applyMode === "ultimate_cloning" && selectedDuration > ULTIMATE_CLONING_RECOMMENDED_MAX_SECONDS) {
      toast.error("当前样本过长，不建议直接套用到整集", {
        description: `极致克隆更适合 ${ULTIMATE_CLONING_RECOMMENDED_MAX_SECONDS} 秒以内的精确短样本。当前选段 ${selectedDuration.toFixed(2)} 秒，建议缩短后再套用，或改用可控克隆。`,
      });
      return;
    }

    try {
      const nextConfig = buildConfigFromProcessedMedia(
        currentConfig,
        applyMode,
        processResult.assetRelativePath,
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
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>素材处理</DialogTitle>
          <DialogDescription>
            先导入素材，再按字幕选段、处理试听，最后决定是否套用到当前 Episode。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[82vh] space-y-5 overflow-y-auto px-5 py-4">
          <section className="space-y-2">
            <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              本地能力
            </div>
            {loadingCapabilities ? (
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                正在检测 ffmpeg、Demucs、WhisperX 和试配音能力…
              </div>
            ) : capabilities ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <CapabilityPill label="ffmpeg" ok={capabilities.ffmpeg} detail={capabilities.ffmpegError} />
                  <CapabilityPill label="ffprobe" ok={capabilities.ffprobe} detail={capabilities.ffprobeError} />
                  <CapabilityPill label="Demucs" ok={capabilities.demucs} detail={capabilities.demucsError} />
                  <CapabilityPill label="WhisperX" ok={capabilities.whisperx} detail={capabilities.whisperxError} />
                  <CapabilityPill label="官方字幕" ok={capabilities.officialSubtitles} />
                  <CapabilityPill label="试配音" ok={capabilities.trialSynthesis} />
                </div>
                <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  素材目录：<code>{capabilities.voiceSourceDir}</code>
                </div>
              </>
            ) : null}
          </section>

          <section className="space-y-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-700">
            <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              第一步：导入素材
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <ChoiceCard
                title="本地文件"
                description="导入本地 mp4、mov、mkv、mp3、wav、m4a 文件。"
                active={sourceMode === "local_file"}
                onClick={() => handleSourceModeChange("local_file")}
              />
              <ChoiceCard
                title="B 站链接"
                description="粘贴公开 B 站链接，直接下载到本地缓存并进入预览。"
                active={sourceMode === "bilibili_link"}
                onClick={() => handleSourceModeChange("bilibili_link")}
              />
            </div>

            {sourceMode === "local_file" ? (
              <div className="space-y-2">
                <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">
                  选择本地文件
                </label>
                <input
                  type="file"
                  accept={ACCEPTED_MEDIA_TYPES}
                  onChange={(event) => handleFileChange(event.target.files?.[0] ?? null)}
                  className="block w-full text-sm text-neutral-700 file:mr-3 file:rounded file:border-0 file:bg-neutral-900 file:px-3 file:py-2 file:text-white hover:file:bg-neutral-800 dark:text-neutral-200 dark:file:bg-neutral-100 dark:file:text-neutral-900 dark:hover:file:bg-neutral-200"
                />
                {selectedFile ? (
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                    当前素材：{selectedFile.name} · {sourceModeLabel(sourceMode)}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-[1fr_220px_auto]">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
                      B 站公开视频链接
                    </label>
                    <input
                      type="text"
                      value={bilibiliUrl}
                      onChange={(event) => setBilibiliUrl(event.target.value)}
                      placeholder="https://www.bilibili.com/video/BV..."
                      className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-neutral-600 dark:bg-neutral-900"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
                      下载目标
                    </label>
                    <select
                      value={downloadTarget}
                      onChange={(event) => setDownloadTarget(event.target.value as BilibiliDownloadTarget)}
                      className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-neutral-600 dark:bg-neutral-900"
                    >
                      <option value="video">下载视频（用于画面预览+剪辑）</option>
                      <option value="audio">仅下载音频（更快提取音色）</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={handleImportBilibili}
                      disabled={importing}
                      className="rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:bg-neutral-300 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500"
                    >
                      {importing ? "下载中…" : "解析并下载"}
                    </button>
                  </div>
                </div>
                {importedMeta ? (
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                    <div>标题：{importedMeta.title}</div>
                    <div>作者：{importedMeta.owner || "未知"}</div>
                    <div>时长：{formatDurationLabel(importedMeta.durationS)}</div>
                    <div>导入方式：{downloadTargetLabel(importedMeta.downloadTarget)}</div>
                  </div>
                ) : null}
              </div>
            )}
          </section>

          <section className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
            <div className="space-y-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-700">
              <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                第二步：预览与字幕选段
              </div>
              {previewUrl ? (
                <div className="space-y-3">
                  {previewKind === "video" ? (
                    <video
                      ref={handleMediaRef}
                      src={previewUrl}
                      controls
                      onLoadedMetadata={handleLoadedMetadata}
                      onTimeUpdate={() => setCurrentTime(mediaRef.current?.currentTime ?? 0)}
                      className="max-h-80 w-full rounded-lg border border-neutral-200 bg-black dark:border-neutral-700"
                    />
                  ) : (
                    <audio
                      ref={handleMediaRef}
                      src={previewUrl}
                      controls
                      onLoadedMetadata={handleLoadedMetadata}
                      onTimeUpdate={() => setCurrentTime(mediaRef.current?.currentTime ?? 0)}
                      className="w-full"
                    />
                  )}

                  <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                    <span>当前时间：{formatTime(currentTime)}</span>
                    <span>总时长：{formatDurationLabel(mediaDuration)}</span>
                    <button
                      type="button"
                      onClick={() => setStartS(currentTime.toFixed(3))}
                      className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                    >
                      设为开始
                    </button>
                    <button
                      type="button"
                      onClick={() => setEndS(currentTime.toFixed(3))}
                      className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                    >
                      设为结束
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectionStart(null);
                        setSelectionEnd(null);
                      }}
                      className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                    >
                      清空选段
                    </button>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="block text-xs text-neutral-600 dark:text-neutral-400">
                      开始时间
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        value={startS}
                        onChange={(event) => setStartS(event.target.value)}
                        className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-neutral-600 dark:bg-neutral-900"
                      />
                    </label>
                    <label className="block text-xs text-neutral-600 dark:text-neutral-400">
                      结束时间
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        value={endS}
                        onChange={(event) => setEndS(event.target.value)}
                        className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-neutral-600 dark:bg-neutral-900"
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                  先导入一个本地文件或 B 站素材，随后会进入字幕选段。
                </div>
              )}
            </div>
            <div className="space-y-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-700">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  字幕选段
                </div>
                {subtitleResult ? (
                  <span className="rounded-full border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
                    {subtitleSourceLabel(subtitleResult.sourceType)} · {subtitleResult.language}
                  </span>
                ) : null}
              </div>

              {resolvingSubtitles ? (
                <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
                  正在解析字幕…
                </div>
              ) : subtitleCues.length > 0 ? (
                <>
                  <div className="h-[168px] space-y-2 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800">
                    {subtitleCues.map((cue, index) => {
                      const isSelected = rangeStartIndex !== null && rangeEndIndex !== null
                        ? index >= rangeStartIndex && index <= rangeEndIndex
                        : false;
                      const isActive = activeCueId === cue.id;
                      return (
                        <button
                          key={cue.id}
                          type="button"
                          ref={(node) => {
                            cueRefs.current[cue.id] = node;
                          }}
                          onClick={() => handleCueClick(index)}
                          className={`block w-full rounded-md border px-3 py-2 text-left text-xs transition ${
                            isSelected
                              ? "border-blue-500 bg-blue-50 text-blue-900 dark:border-blue-400 dark:bg-blue-950/30 dark:text-blue-100"
                              : isActive
                                ? "border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-400 dark:bg-emerald-950/30 dark:text-emerald-100"
                                : "border-transparent hover:border-neutral-300 hover:bg-white dark:hover:border-neutral-600 dark:hover:bg-neutral-900"
                          }`}
                        >
                          <div className="mb-1 font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                            {formatTime(cue.startS)} - {formatTime(cue.endS)}
                          </div>
                          <div className="leading-relaxed">{cue.text}</div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
                    {selectedCues.length > 0 ? (
                      <>
                        <div className="font-medium">已选 {selectedCues.length} 条连续字幕</div>
                        <div className="mt-1 text-neutral-500 dark:text-neutral-400">
                          {selectedText}
                        </div>
                      </>
                    ) : (
                      <div className="text-neutral-500 dark:text-neutral-400">
                        点击一条字幕作为开始，再点击另一条字幕作为结束；中间区间会自动高亮。
                      </div>
                    )}
                  </div>
                </>
              ) : subtitleNeedsWhisperx ? (
                <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                  <div className="font-semibold">没有找到可直接使用的原生字幕</div>
                  <div className="text-xs leading-relaxed">
                    {subtitlePromptMessage || "如果需要字幕选段，可以启用 WhisperX 自动转写。转写过程可能会有点久。"}
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadSubtitles(true)}
                    disabled={resolvingSubtitles || !capabilities?.whisperx}
                    className="rounded bg-amber-700 px-3 py-2 text-xs font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:bg-amber-300 dark:bg-amber-500 dark:hover:bg-amber-400 dark:disabled:bg-amber-900"
                  >
                    启用 WhisperX 自动转写
                  </button>
                  {!capabilities?.whisperx ? (
                    <div className="text-xs">WhisperX 当前不可用，请先启动本地 WhisperX 服务。</div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                  当前还没有可用字幕。你仍然可以手动填写开始和结束时间作为兜底。
                </div>
              )}
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-700">
            <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              第三步：处理与试听
            </div>

            <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr]">
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
                  声音名称
                </label>
                <input
                  type="text"
                  value={assetName}
                  onChange={(event) => setAssetName(sanitizeAssetName(event.target.value))}
                  placeholder="例如：小A的声音"
                  className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-neutral-600 dark:bg-neutral-900"
                />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
                  清理模式
                </div>
                <div className="grid gap-2">
                  <ChoiceCard
                    title="轻量稳定"
                    description="ffmpeg 裁剪、重采样、响度规范，并做轻量降噪。"
                    active={cleanupMode === "light"}
                    onClick={() => setCleanupMode("light")}
                  />
                  <ChoiceCard
                    title="重度人声分离"
                    description="先跑 Demucs 分离人声，再做统一规范化。"
                    active={cleanupMode === "vocal_isolate"}
                    disabled={!capabilities?.demucs}
                    onClick={() => setCleanupMode("vocal_isolate")}
                  />
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
                  套用模式
                </div>
                <div className="grid gap-2">
                  <ChoiceCard
                    title="可控克隆"
                    description="保存为 reference_audio_path，并清掉 prompt 相关字段。"
                    active={applyMode === "controllable_cloning"}
                    onClick={() => setApplyMode("controllable_cloning")}
                  />
                  <ChoiceCard
                    title="极致克隆"
                    description="保存为 prompt_audio_path + prompt_text，并清掉 reference/control。"
                    active={applyMode === "ultimate_cloning"}
                    onClick={() => setApplyMode("ultimate_cloning")}
                  />
                </div>
                {applyMode === "ultimate_cloning" ? (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                    <div>极致克隆更适合精确、短时的样本。</div>
                    <div>当前选段时长：{selectedDuration > 0 ? `${selectedDuration.toFixed(2)} 秒` : "未选择"}。</div>
                    {subtitleResult?.sourceType === "whisperx_generated" ? (
                      <div>当前字幕来自 WhisperX 自动转写，文本与音频只要有细微偏差，就更容易让生成内容跑偏。</div>
                    ) : null}
                    {selectedDuration > ULTIMATE_CLONING_RECOMMENDED_MAX_SECONDS ? (
                      <div>当前样本超过 {ULTIMATE_CLONING_RECOMMENDED_MAX_SECONDS} 秒，建议缩短后再用极致克隆，或改用可控克隆。</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleProcess}
                disabled={!canProcess || processing}
                className="rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:bg-neutral-300 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500"
              >
                {processing ? "处理中…" : "生成处理后素材并试听"}
              </button>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                当前将使用 {cleanupLabel(cleanupMode)} · {applyModeLabel(applyMode)}
              </span>
            </div>
            {processResult ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                    处理后素材
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    先听原始选段，再听处理结果，确认是否需要重新抽卡或改清理模式。
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
                      原始选段试听
                    </div>
                    <audio controls src={buildMediaPreviewUrl(processResult.originalPreviewUrl)} className="w-full" />
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
                      处理后素材试听
                    </div>
                    <audio controls src={buildMediaPreviewUrl(processResult.previewUrl)} className="w-full" />
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                    固定试配音
                  </div>
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                    试配音文稿：欢迎来到姜Sir的TTS工作台，如果觉得好用，请去GitHub给我点个star，你的支持是我继续前进的动力
                  </div>
                  {applyMode === "ultimate_cloning" ? (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
                        最终使用的 prompt_text
                      </label>
                      <textarea
                        value={promptText}
                        onChange={(event) => setPromptText(event.target.value)}
                        className="min-h-24 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-neutral-600 dark:bg-neutral-900"
                      />
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void runTrialSynthesis(processResult, promptText.trim())}
                      disabled={trialing || (applyMode === "ultimate_cloning" && !promptText.trim())}
                      className="rounded border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 disabled:cursor-not-allowed disabled:text-neutral-400 dark:border-neutral-600 dark:hover:bg-neutral-800 dark:disabled:text-neutral-500"
                    >
                      {trialing ? "试听生成中…" : "重新生成试听"}
                    </button>
                    {trialResult ? (
                      <span className="text-xs text-emerald-600 dark:text-emerald-400">
                        最近一次试听时长：{formatDurationLabel(trialResult.durationS)}
                      </span>
                    ) : null}
                  </div>
                  {trialResult ? (
                    <audio controls src={buildMediaPreviewUrl(trialResult.trialPreviewUrl)} className="w-full" />
                  ) : (
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      处理完成后会自动生成一条固定试配音，便于你快速判断克隆效果。
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            关闭
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!canApply}
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:bg-neutral-300 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500"
          >
            套用到当前 Episode
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
