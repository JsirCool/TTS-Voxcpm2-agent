"use client";

import { useCallback, useMemo } from "react";
import useSWR from "swr";
import { getApiUrl } from "./api-client";

export type PresetScope = "project" | "global";

export interface TtsPreset {
  id: string;
  scope: PresetScope;
  name: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  isDefault?: boolean;
}

interface TtsPresetIndexResponse {
  projectPresets: TtsPreset[];
  globalPresets: TtsPreset[];
  defaultProjectPresetId?: string | null;
  defaultGlobalPresetId?: string | null;
  projectPath: string;
  globalPath: string;
}

const CONFIG_KEYS = [
  "cfg_value",
  "inference_timesteps",
  "control_prompt",
  "reference_audio_path",
  "prompt_audio_path",
  "prompt_text",
  "normalize",
  "denoise",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeTtsConfig(input: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    next[key] = value;
  }
  return next;
}

export function normalizeImportedPresetPayload(input: unknown): Record<string, unknown> {
  if (Array.isArray(input)) {
    return { presets: input };
  }

  if (!isRecord(input)) {
    throw new Error("导入文件不是有效的 JSON 对象");
  }

  if (Array.isArray(input.presets)) {
    return input;
  }

  if (isRecord(input.data)) {
    return normalizeImportedPresetPayload(input.data);
  }

  if (Array.isArray(input.items)) {
    return { ...input, presets: input.items };
  }

  if (Array.isArray(input.presetList)) {
    return { ...input, presets: input.presetList };
  }

  throw new Error("导入文件缺少 presets 数组");
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.detail || `请求失败 (${response.status})`);
  }
  return body as T;
}

async function fetchPresetIndex(): Promise<TtsPresetIndexResponse> {
  return requestJson<TtsPresetIndexResponse>(`${getApiUrl()}/tts-presets`, { method: "GET" });
}

export function useTtsPresets() {
  const swr = useSWR<TtsPresetIndexResponse>("api:tts-presets", fetchPresetIndex);

  const projectPresets = swr.data?.projectPresets ?? [];
  const globalPresets = swr.data?.globalPresets ?? [];
  const presets = useMemo(() => [...projectPresets, ...globalPresets], [projectPresets, globalPresets]);
  const defaultPreset = useMemo(
    () =>
      projectPresets.find((preset) => preset.isDefault)
      ?? globalPresets.find((preset) => preset.isDefault)
      ?? presets[0]
      ?? null,
    [globalPresets, presets, projectPresets],
  );

  const refresh = useCallback(async () => {
    await swr.mutate();
  }, [swr]);

  const savePreset = useCallback(async (
    scope: PresetScope,
    name: string,
    config: Record<string, unknown>,
    makeDefault = false,
  ) => {
    const preset = await requestJson<TtsPreset>(`${getApiUrl()}/tts-presets/${scope}`, {
      method: "POST",
      body: JSON.stringify({
        name,
        config: sanitizeTtsConfig(config),
        makeDefault,
      }),
    });
    await swr.mutate();
    return preset;
  }, [swr]);

  const updatePreset = useCallback(async (
    scope: PresetScope,
    id: string,
    patch: Partial<Pick<TtsPreset, "name" | "config" | "isDefault">>,
  ) => {
    await requestJson<TtsPreset>(`${getApiUrl()}/tts-presets/${scope}/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: patch.name,
        config: patch.config ? sanitizeTtsConfig(patch.config) : undefined,
        isDefault: patch.isDefault,
      }),
    });
    await swr.mutate();
  }, [swr]);

  const deletePreset = useCallback(async (scope: PresetScope, id: string) => {
    await requestJson(`${getApiUrl()}/tts-presets/${scope}/${id}`, { method: "DELETE" });
    await swr.mutate();
  }, [swr]);

  const setDefaultPreset = useCallback(async (scope: PresetScope, id: string) => {
    await requestJson(`${getApiUrl()}/tts-presets/${scope}/${id}/default`, { method: "POST", body: "{}" });
    await swr.mutate();
  }, [swr]);

  const importPresets = useCallback(async (scope: PresetScope, data: Record<string, unknown>, replace = false) => {
    await requestJson(`${getApiUrl()}/tts-presets/import`, {
      method: "POST",
      body: JSON.stringify({ scope, data, replace }),
    });
    await swr.mutate();
  }, [swr]);

  const exportPresets = useCallback(async (scope: PresetScope) => {
    const data = await requestJson<{ scope: PresetScope; data: Record<string, unknown> }>(
      `${getApiUrl()}/tts-presets/export/${scope}`,
      { method: "GET" },
    );
    return data.data;
  }, []);

  return {
    presets,
    projectPresets,
    globalPresets,
    projectPath: swr.data?.projectPath ?? "",
    globalPath: swr.data?.globalPath ?? "",
    defaultPreset,
    refresh,
    savePreset,
    updatePreset,
    deletePreset,
    setDefaultPreset,
    importPresets,
    exportPresets,
    isLoading: swr.isLoading,
    error: (swr.error as Error | undefined) ?? null,
  };
}
