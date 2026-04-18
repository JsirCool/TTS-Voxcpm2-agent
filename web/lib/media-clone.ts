"use client";

import { getApiUrl } from "./api-client";
import { inferTtsMode } from "./tts-config";
import { sanitizeTtsConfig } from "./tts-presets";

export type MediaCleanupMode = "light" | "vocal_isolate";
export type MediaApplyMode = "controllable_cloning" | "ultimate_cloning";

export interface MediaCapabilities {
  ffmpeg: boolean;
  ffprobe: boolean;
  demucs: boolean;
  whisperx: boolean;
  ffmpegError?: string | null;
  ffprobeError?: string | null;
  demucsError?: string | null;
  whisperxError?: string | null;
  voiceSourceDir: string;
}

export interface MediaProcessResult {
  relativeAudioPath: string;
  durationS: number;
  cleanupMode: MediaCleanupMode;
  applyMode: MediaApplyMode;
  detectedText?: string | null;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.detail || `请求失败 (${response.status})`);
  }
  return body as T;
}

export async function fetchMediaCapabilities(): Promise<MediaCapabilities> {
  const response = await fetch(`${getApiUrl()}/media/capabilities`, {
    method: "GET",
    credentials: "include",
    headers: process.env.NEXT_PUBLIC_API_TOKEN
      ? { Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN}` }
      : undefined,
  });
  return parseJsonResponse<MediaCapabilities>(response);
}

export async function processCloneMedia(input: {
  file: File;
  startS: number;
  endS: number;
  cleanupMode: MediaCleanupMode;
  applyMode: MediaApplyMode;
}): Promise<MediaProcessResult> {
  const form = new FormData();
  form.append("media", input.file);
  form.append("start_s", String(input.startS));
  form.append("end_s", String(input.endS));
  form.append("cleanup_mode", input.cleanupMode);
  form.append("apply_mode", input.applyMode);

  const response = await fetch(`${getApiUrl()}/media/process`, {
    method: "POST",
    credentials: "include",
    headers: process.env.NEXT_PUBLIC_API_TOKEN
      ? { Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN}` }
      : undefined,
    body: form,
  });
  return parseJsonResponse<MediaProcessResult>(response);
}

export function getDefaultMediaApplyMode(config: Record<string, unknown>): MediaApplyMode {
  return inferTtsMode(config) === "ultimate_cloning" ? "ultimate_cloning" : "controllable_cloning";
}

export function buildConfigFromProcessedMedia(
  currentConfig: Record<string, unknown>,
  applyMode: MediaApplyMode,
  relativeAudioPath: string,
  promptText?: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...currentConfig,
  };

  if (applyMode === "controllable_cloning") {
    next.reference_audio_path = relativeAudioPath;
    delete next.prompt_audio_path;
    delete next.prompt_text;
  } else {
    next.prompt_audio_path = relativeAudioPath;
    next.prompt_text = (promptText ?? "").trim();
    delete next.reference_audio_path;
    delete next.control_prompt;
  }

  return sanitizeTtsConfig(next);
}
