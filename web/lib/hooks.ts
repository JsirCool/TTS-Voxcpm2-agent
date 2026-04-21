"use client";

import { useEffect } from "react";
import useSWR from "swr";
import type { Chunk, ChunkEdit, Episode, EpisodeSummary, StageName } from "./types";
import type { components } from "./gen/openapi";
import { api, getApiUrl } from "./api-client";
import { connectSSE } from "./sse-client";
import type { StageEventData } from "./sse-client";

function apiError(err: unknown): Error {
  if (typeof err === "object" && err !== null && "detail" in err) {
    return new Error((err as { detail: string }).detail);
  }
  return new Error(typeof err === "string" ? err : JSON.stringify(err));
}

// ---------------------------------------------------------------------------
// Type aliases from generated OpenAPI schemas
// ---------------------------------------------------------------------------

type ApiEpisodeSummary = components["schemas"]["EpisodeSummary"];
type ApiEpisodeDetail = components["schemas"]["EpisodeDetail"];

// ---------------------------------------------------------------------------
// Converters: generated API types → frontend domain types
//
// Since backend outputs camelCase, these are mostly identity casts.
// Only needed where frontend types differ from API types (e.g. optional
// vs nullable, extra computed fields).
// ---------------------------------------------------------------------------

function toEpisodeSummary(raw: ApiEpisodeSummary): EpisodeSummary {
  return raw as unknown as EpisodeSummary;
}

function toEpisode(raw: ApiEpisodeDetail): Episode {
  return raw as unknown as Episode;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

interface HookResult<T> {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
  mutate: () => Promise<unknown>;
}

export type LocalServiceStatusSnapshot = {
  harnessApi: boolean;
  voxcpm: boolean | null;
  whisperx: boolean | null;
  updatedAt: number;
  errors: {
    harnessApi?: string | null;
    voxcpm?: string | null;
    whisperx?: string | null;
    capabilities?: string | null;
  };
};

type MediaCapabilitiesPayload = {
  whisperx?: boolean;
  whisperxError?: string | null;
  voxcpm?: boolean;
  voxcpmError?: string | null;
  trialSynthesis?: boolean;
};

export function useEpisodes(): HookResult<EpisodeSummary[]> {
  const swr = useSWR<EpisodeSummary[]>("api:episodes", async () => {
    const { data, error } = await api.GET("/episodes");
    if (error) throw apiError(error);
    return (data ?? []).map(toEpisodeSummary);
  });
  return {
    data: swr.data,
    error: (swr.error as Error) ?? null,
    isLoading: swr.isLoading,
    mutate: swr.mutate,
  };
}

export function useEpisode(id: string | null): HookResult<Episode> {
  const swr = useSWR<Episode>(
    id ? `api:episode:${id}` : null,
    async () => {
      const { data, error } = await api.GET("/episodes/{episode_id}", {
        params: { path: { episode_id: id! } },
      });
      if (error) throw apiError(error);
      return toEpisode(data!);
    },
    {
      refreshInterval: (data) => (
        data?.status === "running"
        || data?.chunks?.some((chunk) => chunk.stageRuns.some((stageRun) => stageRun.status === "running"))
          ? 2000
          : 0
      ),
    },
  );

  // SSE real-time updates
  const mutate = swr.mutate;
  useEffect(() => {
    if (!id) return;
    const conn = connectSSE(
      id,
      (_event: StageEventData) => { mutate(); },
      () => { /* SSE error — SWR polling is fallback */ },
    );
    return () => conn.close();
  }, [id, mutate]);

  return {
    data: swr.data,
    error: (swr.error as Error) ?? null,
    isLoading: swr.isLoading,
    mutate: swr.mutate,
  };
}

export function useLocalServiceStatus(): HookResult<LocalServiceStatusSnapshot> {
  const swr = useSWR<LocalServiceStatusSnapshot>(
    "api:local-service-status",
    async () => {
      const baseUrl = getApiUrl();
      const errors: LocalServiceStatusSnapshot["errors"] = {};
      let harnessApi = false;

      try {
        const health = await fetch(`${baseUrl}/healthz`, {
          cache: "no-store",
          credentials: "include",
          headers: authHeaders(),
        });
        harnessApi = health.ok;
        if (!health.ok) errors.harnessApi = `HTTP ${health.status}`;
      } catch (error) {
        errors.harnessApi = error instanceof Error ? error.message : String(error);
      }

      if (!harnessApi) {
        return {
          harnessApi: false,
          voxcpm: false,
          whisperx: false,
          updatedAt: Date.now(),
          errors,
        };
      }

      let voxcpm: boolean | null = null;
      let whisperx: boolean | null = null;
      try {
        const response = await fetch(`${baseUrl}/media/capabilities`, {
          cache: "no-store",
          credentials: "include",
          headers: authHeaders(),
        });
        if (!response.ok) {
          errors.capabilities = `HTTP ${response.status}`;
          voxcpm = false;
          whisperx = false;
        } else {
          const payload = await response.json() as MediaCapabilitiesPayload;
          voxcpm = Boolean(payload.voxcpm ?? payload.trialSynthesis);
          whisperx = Boolean(payload.whisperx);
          errors.voxcpm = payload.voxcpmError ?? null;
          errors.whisperx = payload.whisperxError ?? null;
        }
      } catch (error) {
        errors.capabilities = error instanceof Error ? error.message : String(error);
        voxcpm = false;
        whisperx = false;
      }

      return {
        harnessApi,
        voxcpm,
        whisperx,
        updatedAt: Date.now(),
        errors,
      };
    },
    {
      refreshInterval: 5000,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  );
  return {
    data: swr.data,
    error: (swr.error as Error) ?? null,
    isLoading: swr.isLoading,
    mutate: swr.mutate,
  };
}

// ---------------------------------------------------------------------------
// Imperative operations (type-safe via openapi-fetch)
// ---------------------------------------------------------------------------

export async function createEpisode(
  id: string,
  file: File,
  options?: { title?: string; config?: Record<string, unknown> },
): Promise<void> {
  const { error } = await api.POST("/episodes", {
    body: { id, title: options?.title, config: options?.config, script: file } as never, // multipart — openapi-fetch handles FormData
    bodySerializer: (body: Record<string, unknown>) => {
      const fd = new FormData();
      fd.append("id", body.id as string);
      if (typeof body.title === "string" && body.title.trim()) {
        fd.append("title", body.title);
      }
      fd.append("config", JSON.stringify((body.config as Record<string, unknown> | undefined) ?? {}));
      fd.append("script", body.script as File);
      return fd;
    },
  });
  if (error) throw apiError(error);
}

export async function deleteEpisode(id: string): Promise<void> {
  const { error } = await api.DELETE("/episodes/{episode_id}", {
    params: { path: { episode_id: id } },
  });
  if (error) throw apiError(error);
}

export async function duplicateEpisode(
  id: string,
  newId: string,
): Promise<void> {
  const { error } = await api.POST("/episodes/{episode_id}/duplicate", {
    params: { path: { episode_id: id } },
    body: { newId },
  });
  if (error) throw apiError(error);
}

export async function archiveEpisode(id: string): Promise<void> {
  const { error } = await api.POST("/episodes/{episode_id}/archive", {
    params: { path: { episode_id: id } },
  });
  if (error) throw apiError(error);
}

export async function runEpisode(
  id: string,
  mode: string = "synthesize",
  chunkIds?: string[],
): Promise<string> {
  const { data, error } = await api.POST("/episodes/{episode_id}/run", {
    params: { path: { episode_id: id } },
    body: { mode, chunkIds: chunkIds ?? null } as never,
  });
  if (error) throw apiError(error);
  return data!.flowRunId;
}

export async function applyEdits(
  id: string,
  edits: Record<string, ChunkEdit>,
): Promise<void> {
  for (const [cid, edit] of Object.entries(edits)) {
    const params = new URLSearchParams();
    if (edit.textNormalized !== undefined) params.set("text_normalized", edit.textNormalized);
    if (edit.subtitleText !== undefined) params.set("subtitle_text", edit.subtitleText);
    if (edit.controlPrompt !== undefined) params.set("control_prompt", edit.controlPrompt);
    if (edit.clearControlPrompt) params.set("clear_control_prompt", "true");

    const res = await fetch(
      `${getApiUrl()}/episodes/${encodeURIComponent(id)}/chunks/${encodeURIComponent(cid)}/edit?${params.toString()}`,
      {
        method: "POST",
        credentials: "include",
        headers: process.env.NEXT_PUBLIC_API_TOKEN
          ? { Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN}` }
          : undefined,
      },
    );
    if (!res.ok) {
      let detail = `请求失败 (${res.status})`;
      try {
        const body = await res.json();
        if (body?.detail) detail = body.detail;
      } catch {
        // ignore parse failure
      }
      throw new Error(detail);
    }

    const fromStage =
      edit.textNormalized !== undefined
      || edit.controlPrompt !== undefined
      || edit.clearControlPrompt
        ? "p2"
        : "p5";
    await api.POST("/episodes/{episode_id}/chunks/{chunk_id}/retry", {
      params: {
        path: { episode_id: id, chunk_id: cid },
        query: { from_stage: fromStage, cascade: true },
      },
    });
  }
}

export async function retryChunk(
  epId: string,
  cid: string,
  fromStage: StageName,
  cascade = true,
): Promise<string> {
  const { data, error } = await api.POST(
    "/episodes/{episode_id}/chunks/{chunk_id}/retry",
    {
      params: {
        path: { episode_id: epId, chunk_id: cid },
        query: { from_stage: fromStage, cascade },
      },
    },
  );
  if (error) throw apiError(error);
  return data!.flowRunId;
}

async function fetchError(res: Response): Promise<Error> {
  let detail = `请求失败 (${res.status})`;
  try {
    const body = await res.json();
    if (body?.detail) detail = body.detail;
  } catch {
    try {
      detail = await res.text();
    } catch {
      // keep generic status message
    }
  }
  return new Error(detail);
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  return {
    ...(extra ?? {}),
    ...(process.env.NEXT_PUBLIC_API_TOKEN
      ? { Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN}` }
      : {}),
  };
}

export async function confirmChunkReview(
  epId: string,
  cid: string,
): Promise<void> {
  const res = await fetch(
    `${getApiUrl()}/episodes/${encodeURIComponent(epId)}/chunks/${encodeURIComponent(cid)}/confirm-review`,
    {
      method: "POST",
      credentials: "include",
      headers: process.env.NEXT_PUBLIC_API_TOKEN
        ? { Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN}` }
        : undefined,
    },
  );
  if (!res.ok) {
    let detail = `请求失败 (${res.status})`;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // ignore parse failure
    }
    throw new Error(detail);
  }
}

export async function updateChunkGap(
  epId: string,
  cid: string,
  nextGapMs: number | null,
): Promise<Chunk> {
  const res = await fetch(
    `${getApiUrl()}/episodes/${encodeURIComponent(epId)}/chunks/${encodeURIComponent(cid)}/gap`,
    {
      method: "PATCH",
      credentials: "include",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ nextGapMs }),
    },
  );
  if (!res.ok) throw await fetchError(res);
  return await res.json() as Chunk;
}

export async function fetchChunkGapPreview(
  epId: string,
  cid: string,
  gapMs: number,
): Promise<Blob> {
  const res = await fetch(
    `${getApiUrl()}/episodes/${encodeURIComponent(epId)}/chunks/${encodeURIComponent(cid)}/gap-preview`,
    {
      method: "POST",
      credentials: "include",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ gapMs }),
    },
  );
  if (!res.ok) throw await fetchError(res);
  return await res.blob();
}

export async function fetchEpisodeGapPreview(epId: string): Promise<Blob> {
  const res = await fetch(
    `${getApiUrl()}/episodes/${encodeURIComponent(epId)}/gap-preview`,
    {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
    },
  );
  if (!res.ok) throw await fetchError(res);
  return await res.blob();
}

export async function finalizeTake(
  epId: string,
  cid: string,
  takeId: string,
): Promise<string> {
  const { data, error } = await api.POST(
    "/episodes/{episode_id}/chunks/{chunk_id}/finalize-take",
    {
      params: {
        path: { episode_id: epId, chunk_id: cid },
        query: { take_id: takeId },
      },
    },
  );
  if (error) throw apiError(error);
  return data!.flowRunId;
}

/** Convert a MinIO URI to an accessible URL. */
export function getAudioUrl(audioUri: string): string {
  return `${getApiUrl()}/audio/${encodeURIComponent(audioUri)}`;
}

export function useEpisodeLogs(id: string | null, tail = 50) {
  return useSWR<string[]>(
    id ? `api:logs:${id}` : null,
    async () => {
      const { data, error } = await api.GET("/episodes/{episode_id}/logs", {
        params: {
          path: { episode_id: id! },
          query: { tail },
        },
      });
      if (error) throw apiError(error);
      return data?.lines ?? [];
    },
    {
      refreshInterval: 5000,
    },
  );
}

export async function updateConfig(
  id: string,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await api.PUT("/episodes/{episode_id}/config", {
    params: { path: { episode_id: id } },
    body: { config },
  });
  if (error) throw apiError(error);
  return data!.config;
}

export async function exportEpisode(id: string, dir: string): Promise<void> {
  const res = await fetch(`${getApiUrl()}/episodes/${encodeURIComponent(id)}/export-local`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ directory: dir }),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
}
