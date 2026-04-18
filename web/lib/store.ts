/**
 * Zustand store — centralized UI state + async actions.
 *
 * Components read state via useHarnessStore(selector).
 * Components trigger actions via store.xxx() — never fetch directly.
 *
 * Server state (episodes, chunks) lives in SWR hooks (hooks.ts).
 * This store only manages CLIENT-SIDE UI state + async commands.
 */

import { create } from "zustand";
import { toast } from "sonner";
import type { ChunkEdit, EditBatch, StageName } from "./types";
import * as api from "./hooks";
import { playExclusiveAudio, stopExclusiveAudio } from "./audio-session";

interface HarnessState {
  // --- UI state ---
  selectedId: string | null;
  editing: string | null;
  playingChunkId: string | null;
  continuousPlay: boolean;
  playbackRate: number;
  chunkPlayOrder: string[];
  edits: EditBatch;
  drawerOpen: { cid: string; stage: StageName } | null;
  helpOpen: boolean;
  sidebarCollapsed: boolean;

  // --- UI actions ---
  selectEpisode: (id: string) => void;
  startEditing: (cid: string) => void;
  cancelEditing: () => void;
  togglePlay: (cid: string) => void;
  setPlayingChunkId: (cid: string | null) => void;
  setContinuousPlay: (v: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  setChunkPlayOrder: (ids: string[]) => void;
  playAll: () => void;
  stopAll: () => void;
  advanceToNext: () => void;
  stageEdit: (cid: string, draft: ChunkEdit) => void;
  discardEdits: () => void;
  openDrawer: (cid: string, stage: StageName) => void;
  closeDrawer: () => void;
  setHelpOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  // --- Computed ---
  dirtyCount: () => { tts: number; sub: number };

  // --- Async actions (call API → update state) ---
  runEpisode: (mode: string, chunkIds?: string[]) => Promise<void>;
  applyEdits: (episodeId: string) => Promise<void>;
  retryChunk: (epId: string, cid: string, stage: StageName, cascade: boolean) => Promise<void>;
  createEpisode: (id: string, file: File, options?: { title?: string; config?: Record<string, unknown> }) => Promise<void>;
  deleteEpisode: (id: string) => Promise<void>;
  duplicateEpisode: (id: string, newId: string) => Promise<void>;
  archiveEpisode: (id: string) => Promise<void>;
  updateConfig: (epId: string, config: Record<string, unknown>) => Promise<void>;
  finalizeTake: (epId: string, cid: string, takeId: string) => Promise<void>;
  previewTake: (audioUri: string) => void;
}

function describeMediaError(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "播放被浏览器中断了。";
    case MediaError.MEDIA_ERR_NETWORK:
      return "音频请求失败，请检查 API 和网络。";
    case MediaError.MEDIA_ERR_DECODE:
      return "浏览器没能解码这条音频。";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "浏览器不支持当前音频地址或格式。";
    default:
      return "浏览器没有成功播放这条音频。";
  }
}

function isBenignPlaybackInterruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return error instanceof DOMException && error.name === "AbortError"
    || /interrupted by a call to pause\(\)/i.test(message)
    || /interrupted by a new load request/i.test(message)
    || /play\(\) request was interrupted/i.test(message);
}

function notifyPlaybackFailure(error?: unknown, mediaError?: MediaError | null) {
  if (isBenignPlaybackInterruption(error)) return;
  const description = error instanceof Error
    ? error.message
    : describeMediaError(mediaError ?? null);
  toast.error("音频播放失败", { description });
}

export const useHarnessStore = create<HarnessState>((set, get) => ({
  // --- Initial state ---
  // SSR-safe defaults: localStorage values restored via useEffect in page.tsx
  selectedId: null,
  editing: null,
  playingChunkId: null,
  continuousPlay: false,
  playbackRate: 1,
  chunkPlayOrder: [],
  edits: {},
  drawerOpen: null,
  helpOpen: false,
  sidebarCollapsed: false,

  // --- UI actions ---
  selectEpisode: (id) => {
    stopExclusiveAudio();
    set({ selectedId: id, edits: {}, editing: null, playingChunkId: null, drawerOpen: null });
    if (typeof window !== "undefined") window.localStorage.setItem("tts-harness:selectedEpisode", id);
  },

  startEditing: (cid) => set((s) => ({ editing: s.editing === cid ? null : cid })),
  cancelEditing: () => set({ editing: null }),

  togglePlay: (cid) => set((s) => ({
    playingChunkId: s.playingChunkId === cid ? null : cid,
    continuousPlay: false,
  })),
  setPlayingChunkId: (cid) => set({ playingChunkId: cid }),

  setContinuousPlay: (v) => set({ continuousPlay: v }),
  setPlaybackRate: (rate) => set({ playbackRate: rate }),
  setChunkPlayOrder: (ids) => set({ chunkPlayOrder: ids }),

  playAll: () => {
    const order = get().chunkPlayOrder;
    if (order.length === 0) return;
    set({ continuousPlay: true, playingChunkId: order[0] });
  },
  stopAll: () => set({ continuousPlay: false, playingChunkId: null }),
  advanceToNext: () => {
    const { chunkPlayOrder, playingChunkId } = get();
    const idx = chunkPlayOrder.indexOf(playingChunkId ?? "");
    const next = idx >= 0 && idx < chunkPlayOrder.length - 1 ? chunkPlayOrder[idx + 1] : null;
    if (next) {
      set({ playingChunkId: next });
    } else {
      set({ continuousPlay: false, playingChunkId: null });
    }
  },

  stageEdit: (cid, draft) => set((s) => {
    const next = { ...s.edits };
    if (Object.keys(draft).length === 0) { delete next[cid]; } else { next[cid] = draft; }
    return { edits: next, editing: null, playingChunkId: s.playingChunkId === cid ? null : s.playingChunkId };
  }),

  discardEdits: () => set({ edits: {} }),

  openDrawer: (cid, stage) => set({ drawerOpen: { cid, stage } }),
  closeDrawer: () => set({ drawerOpen: null }),

  setHelpOpen: (open) => set({ helpOpen: open }),

  setSidebarCollapsed: (collapsed) => {
    set({ sidebarCollapsed: collapsed });
    if (typeof window !== "undefined") window.localStorage.setItem("tts-harness:sidebarCollapsed", String(collapsed));
  },

  // --- Computed ---
  dirtyCount: () => {
    const edits = get().edits;
    let tts = 0, sub = 0;
    for (const e of Object.values(edits)) {
      if (e.textNormalized !== undefined || e.controlPrompt !== undefined || e.clearControlPrompt) tts++;
      if (e.subtitleText !== undefined) sub++;
    }
    return { tts, sub };
  },

  // --- Async actions ---
  runEpisode: async (mode, chunkIds) => {
    const id = get().selectedId;
    if (!id) return;
    await api.runEpisode(id, mode, chunkIds);
  },

  applyEdits: async (episodeId) => {
    const edits = get().edits;
    if (Object.keys(edits).length === 0) return;
    await api.applyEdits(episodeId, edits);
    stopExclusiveAudio();
    set({ edits: {}, playingChunkId: null });
  },

  retryChunk: async (epId, cid, stage, cascade) => {
    await api.retryChunk(epId, cid, stage, cascade);
  },

  createEpisode: async (id, file, options) => {
    await api.createEpisode(id, file, options);
  },

  deleteEpisode: async (id) => {
    await api.deleteEpisode(id);
    if (get().selectedId === id) {
      set({ selectedId: null });
      if (typeof window !== "undefined") window.localStorage.removeItem("tts-harness:selectedEpisode");
    }
  },

  duplicateEpisode: async (id, newId) => {
    await api.duplicateEpisode(id, newId);
    set({ selectedId: newId });
    if (typeof window !== "undefined") window.localStorage.setItem("tts-harness:selectedEpisode", newId);
  },

  archiveEpisode: async (id) => {
    await api.archiveEpisode(id);
    if (get().selectedId === id) {
      set({ selectedId: null });
      if (typeof window !== "undefined") window.localStorage.removeItem("tts-harness:selectedEpisode");
    }
  },

  updateConfig: async (epId, config) => {
    await api.updateConfig(epId, config);
  },

  finalizeTake: async (epId, cid, takeId) => {
    await api.finalizeTake(epId, cid, takeId);
  },

  previewTake: (audioUri) => {
    stopExclusiveAudio();
    set({ playingChunkId: null, continuousPlay: false });
    const audio = new Audio(api.getAudioUrl(audioUri));
    audio.preload = "metadata";
    audio.muted = false;
    audio.volume = 1;
    audio.addEventListener("error", () => {
      notifyPlaybackFailure(undefined, audio.error);
    }, { once: true });
    audio.addEventListener("ended", () => stopExclusiveAudio(audio), { once: true });
    playExclusiveAudio(audio).catch((error) => {
      stopExclusiveAudio(audio);
      notifyPlaybackFailure(error, audio.error);
    });
  },
}));
