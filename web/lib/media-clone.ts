"use client";

import { getApiUrl } from "./api-client";
import { inferTtsMode } from "./tts-config";
import { sanitizeTtsConfig } from "./tts-presets";

export type MediaCleanupMode = "light" | "vocal_isolate";
export type MediaApplyMode = "controllable_cloning" | "ultimate_cloning";
export type MediaSourceMode = "local_file" | "bilibili_link";
export type BilibiliDownloadTarget = "video" | "audio";
export type SubtitleSourceType = "bilibili_official" | "whisperx_generated";

export interface MediaCapabilities {
  ffmpeg: boolean;
  ffprobe: boolean;
  demucs: boolean;
  whisperx: boolean;
  bilibiliEnabled: boolean;
  bilibiliPublicOnly: boolean;
  bilibiliLoginSupported: boolean;
  officialSubtitles: boolean;
  subtitleResolver: boolean;
  trialSynthesis: boolean;
  ffmpegError?: string | null;
  ffprobeError?: string | null;
  demucsError?: string | null;
  whisperxError?: string | null;
  voiceSourceDir: string;
  bilibiliImportDir: string;
}

export interface MediaProcessResult {
  relativeAudioPath: string;
  durationS: number;
  cleanupMode: MediaCleanupMode;
  applyMode: MediaApplyMode;
  detectedText?: string | null;
  previewUrl: string;
  originalPreviewUrl: string;
  assetRelativePath: string;
  selectedText: string;
}

export interface BilibiliImportResult {
  sourceRelativePath: string;
  absolutePath: string;
  previewUrl: string;
  mediaType: "video" | "audio";
  title: string;
  owner?: string | null;
  durationS: number;
  downloadTarget: BilibiliDownloadTarget;
}

export interface LocalMediaPickResult {
  sourceRelativePath: string;
  absolutePath: string;
  previewUrl: string;
  mediaType: "video" | "audio";
  filename: string;
  sizeBytes: number;
}

export interface SubtitleCue {
  id: string;
  startS: number;
  endS: number;
  text: string;
}

export interface SubtitleResolveResult {
  sourceType: SubtitleSourceType;
  language: string;
  cues: SubtitleCue[];
}

export interface TrialSynthesisResult {
  trialAudioPath: string;
  trialPreviewUrl: string;
  durationS: number;
  sampleText: string;
}

export interface MediaWaveformResult {
  durationS: number;
  bins: number;
  peaks: number[];
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(
      new Error(body?.detail || `请求失败 (${response.status})`),
      {
        code: body?.error,
        status: response.status,
      },
    );
  }
  return body as T;
}

function buildAuthHeaders(contentType?: string): HeadersInit | undefined {
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  if (process.env.NEXT_PUBLIC_API_TOKEN) {
    headers.Authorization = `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export async function fetchMediaCapabilities(): Promise<MediaCapabilities> {
  const response = await fetch(`${getApiUrl()}/media/capabilities`, {
    method: "GET",
    credentials: "include",
    headers: buildAuthHeaders(),
  });
  return parseJsonResponse<MediaCapabilities>(response);
}

export async function importBilibiliMedia(input: {
  url: string;
  downloadTarget: BilibiliDownloadTarget;
}): Promise<BilibiliImportResult> {
  const response = await fetch(`${getApiUrl()}/media/import/bilibili`, {
    method: "POST",
    credentials: "include",
    headers: buildAuthHeaders("application/json"),
    body: JSON.stringify({
      url: input.url,
      downloadTarget: input.downloadTarget,
    }),
  });
  return parseJsonResponse<BilibiliImportResult>(response);
}

export async function pickLocalMediaSource(): Promise<LocalMediaPickResult> {
  const response = await fetch(`${getApiUrl()}/media/local-file/pick`, {
    method: "POST",
    credentials: "include",
    headers: buildAuthHeaders(),
  });
  return parseJsonResponse<LocalMediaPickResult>(response);
}

export async function openBilibiliImportFolder(): Promise<string> {
  const response = await fetch(`${getApiUrl()}/media/imported-bilibili/open`, {
    method: "POST",
    credentials: "include",
    headers: buildAuthHeaders(),
  });
  const body = await parseJsonResponse<{ path: string }>(response);
  return body.path;
}

export async function resolveMediaSubtitles(input: {
  file?: File | null;
  sourceRelativePath?: string | null;
  allowWhisperx?: boolean;
}): Promise<SubtitleResolveResult> {
  const form = new FormData();
  if (input.file) {
    form.append("media", input.file);
  }
  if (input.sourceRelativePath) {
    form.append("source_relative_path", input.sourceRelativePath);
  }
  form.append("allow_whisperx", input.allowWhisperx ? "true" : "false");

  const response = await fetch(`${getApiUrl()}/media/subtitles/resolve`, {
    method: "POST",
    credentials: "include",
    headers: buildAuthHeaders(),
    body: form,
  });
  return parseJsonResponse<SubtitleResolveResult>(response);
}

export async function processCloneMedia(input: {
  file?: File | null;
  sourceRelativePath?: string | null;
  startS: number;
  endS: number;
  cleanupMode: MediaCleanupMode;
  applyMode: MediaApplyMode;
  assetName: string;
  selectedText?: string;
}): Promise<MediaProcessResult> {
  const form = new FormData();
  if (input.file) {
    form.append("media", input.file);
  }
  if (input.sourceRelativePath) {
    form.append("source_relative_path", input.sourceRelativePath);
  }
  form.append("start_s", String(input.startS));
  form.append("end_s", String(input.endS));
  form.append("cleanup_mode", input.cleanupMode);
  form.append("apply_mode", input.applyMode);
  form.append("asset_name", input.assetName);
  form.append("selected_text", input.selectedText ?? "");

  const response = await fetch(`${getApiUrl()}/media/process`, {
    method: "POST",
    credentials: "include",
    headers: buildAuthHeaders(),
    body: form,
  });
  return parseJsonResponse<MediaProcessResult>(response);
}

export async function fetchMediaWaveform(input: {
  file?: File | null;
  sourceRelativePath?: string | null;
  bins?: number;
}): Promise<MediaWaveformResult> {
  const form = new FormData();
  if (input.file) {
    form.append("media", input.file);
  }
  if (input.sourceRelativePath) {
    form.append("source_relative_path", input.sourceRelativePath);
  }
  form.append("bins", String(input.bins ?? 2400));

  const response = await fetch(`${getApiUrl()}/media/waveform`, {
    method: "POST",
    credentials: "include",
    headers: buildAuthHeaders(),
    body: form,
  });
  return parseJsonResponse<MediaWaveformResult>(response);
}

export async function requestSelectionPreview(input: {
  file?: File | null;
  sourceRelativePath?: string | null;
  startS: number;
  endS: number;
}): Promise<Blob> {
  const form = new FormData();
  if (input.file) {
    form.append("media", input.file);
  }
  if (input.sourceRelativePath) {
    form.append("source_relative_path", input.sourceRelativePath);
  }
  form.append("start_s", String(input.startS));
  form.append("end_s", String(input.endS));

  const response = await fetch(`${getApiUrl()}/media/selection-preview`, {
    method: "POST",
    credentials: "include",
    headers: buildAuthHeaders(),
    body: form,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw Object.assign(
      new Error(body?.detail || `请求失败 (${response.status})`),
      {
        code: body?.error,
        status: response.status,
      },
    );
  }
  return response.blob();
}

export async function requestTrialSynthesis(input: {
  applyMode: MediaApplyMode;
  assetRelativePath: string;
  promptText?: string;
  baseConfig?: Record<string, unknown>;
}): Promise<TrialSynthesisResult> {
  const response = await fetch(`${getApiUrl()}/media/trial-synthesis`, {
    method: "POST",
    credentials: "include",
    headers: buildAuthHeaders("application/json"),
    body: JSON.stringify({
      applyMode: input.applyMode,
      assetRelativePath: input.assetRelativePath,
      promptText: input.promptText,
      baseConfig: input.baseConfig ?? {},
    }),
  });
  return parseJsonResponse<TrialSynthesisResult>(response);
}

export function buildMediaPreviewUrl(previewUrl: string): string {
  if (!previewUrl) return "";
  if (/^https?:\/\//i.test(previewUrl)) return previewUrl;
  if (previewUrl.startsWith("/")) {
    return `${getApiUrl()}${previewUrl}`;
  }
  return `${getApiUrl()}/${previewUrl}`;
}

export function getDefaultMediaApplyMode(config: Record<string, unknown>): MediaApplyMode {
  return inferTtsMode(config) === "ultimate_cloning" ? "ultimate_cloning" : "controllable_cloning";
}

export function buildNeutralTrialConfig(config: Record<string, unknown>): Record<string, unknown> {
  const source = sanitizeTtsConfig({ ...config });
  const next: Record<string, unknown> = {};
  for (const key of ["cfg_value", "inference_timesteps", "max_len", "speed", "normalize", "denoise"]) {
    if (source[key] !== undefined) {
      next[key] = source[key];
    }
  }
  return next;
}

export function buildConfigFromProcessedMedia(
  currentConfig: Record<string, unknown>,
  applyMode: MediaApplyMode,
  assetRelativePath: string,
  promptText?: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...currentConfig,
  };

  if (applyMode === "controllable_cloning") {
    next.reference_audio_path = assetRelativePath;
    delete next.prompt_audio_path;
    delete next.prompt_text;
  } else {
    next.prompt_audio_path = assetRelativePath;
    next.prompt_text = (promptText ?? "").trim();
    delete next.reference_audio_path;
    delete next.control_prompt;
  }

  return sanitizeTtsConfig(next);
}
