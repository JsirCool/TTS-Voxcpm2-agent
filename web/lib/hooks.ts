"use client";

import useSWR from "swr";
import type { Episode, EpisodeSummary, ChunkEdit } from "./types";
import {
  fixtureEpisodeSummaries,
  fixtureEpisodes,
  fixtureLogTail,
} from "./__fixtures__/ch04";

const USE_FIXTURES = process.env.NEXT_PUBLIC_USE_FIXTURES === "1";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });

export interface EpisodeDetailResponse {
  episode: Episode;
  logTail: string[];
  running: boolean;
  currentStage: string | null;
}

export interface EpisodeListResponse {
  episodes: EpisodeSummary[];
}

interface HookResult<T> {
  data: T | null | undefined;
  error: Error | null;
  isLoading: boolean;
  mutate: () => Promise<unknown>;
}

export function useEpisodes(): HookResult<EpisodeListResponse> {
  // hooks must always be called; in fixture mode we pass null key to disable fetch
  const swr = useSWR<EpisodeListResponse>(
    USE_FIXTURES ? null : "/api/episodes",
    fetcher,
  );
  if (USE_FIXTURES) {
    return {
      data: { episodes: fixtureEpisodeSummaries },
      error: null,
      isLoading: false,
      mutate: async () => undefined,
    };
  }
  return {
    data: swr.data,
    error: (swr.error as Error) ?? null,
    isLoading: swr.isLoading,
    mutate: swr.mutate,
  };
}

export function useEpisode(
  id: string | null,
): HookResult<EpisodeDetailResponse> {
  const swr = useSWR<EpisodeDetailResponse>(
    USE_FIXTURES || !id ? null : `/api/episodes/${id}`,
    fetcher,
    {
      refreshInterval: (data) => (data?.running ? 2000 : 0),
    },
  );
  if (USE_FIXTURES) {
    if (!id) {
      return {
        data: null,
        error: null,
        isLoading: false,
        mutate: async () => undefined,
      };
    }
    const ep = fixtureEpisodes[id];
    if (!ep) {
      return {
        data: null,
        error: new Error("not found"),
        isLoading: false,
        mutate: async () => undefined,
      };
    }
    return {
      data: {
        episode: ep,
        logTail: fixtureLogTail.split("\n"),
        running: false,
        currentStage: null,
      },
      error: null,
      isLoading: false,
      mutate: async () => undefined,
    };
  }
  return {
    data: swr.data,
    error: (swr.error as Error) ?? null,
    isLoading: swr.isLoading,
    mutate: swr.mutate,
  };
}

// ============================================================
// Mutations
// ============================================================

export async function runEpisode(id: string) {
  if (USE_FIXTURES) {
    await new Promise((r) => setTimeout(r, 1500));
    return { jobId: "fake", startedAt: new Date().toISOString() };
  }
  const r = await fetch(`/api/episodes/${id}/run`, { method: "POST" });
  if (r.status === 409) throw new Error("busy");
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export async function applyEdits(
  id: string,
  edits: Record<string, ChunkEdit>,
) {
  if (USE_FIXTURES) {
    await new Promise((r) => setTimeout(r, 1500));
    return { jobId: "fake", startedAt: new Date().toISOString() };
  }
  const r = await fetch(`/api/episodes/${id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edits }),
  });
  if (r.status === 409) throw new Error("busy");
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export async function retryChunk(id: string, cid: string, count: number) {
  if (USE_FIXTURES) {
    await new Promise((r) => setTimeout(r, count * 800));
    return { jobId: "fake", startedAt: new Date().toISOString() };
  }
  const r = await fetch(
    `/api/episodes/${id}/chunks/${cid}/retry?count=${count}`,
    { method: "POST" },
  );
  if (r.status === 409) throw new Error("busy");
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export async function exportEpisode(id: string, targetDir: string) {
  if (USE_FIXTURES) {
    await new Promise((r) => setTimeout(r, 500));
    return { filesCopied: 8, totalBytes: 0 };
  }
  const r = await fetch(`/api/episodes/${id}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetDir }),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export async function createEpisode(id: string, file: File) {
  if (USE_FIXTURES) {
    await new Promise((r) => setTimeout(r, 500));
    return { id, status: "ready" };
  }
  const fd = new FormData();
  fd.append("id", id);
  fd.append("script", file);
  const r = await fetch("/api/episodes", { method: "POST", body: fd });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// audio URL helper
export function getAudioUrl(
  epId: string,
  cid: string,
  takeId: string,
): string {
  if (USE_FIXTURES) return "";
  return `/api/audio/${epId}/${cid}/${takeId}`;
}
