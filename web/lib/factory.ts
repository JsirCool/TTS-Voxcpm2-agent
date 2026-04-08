/**
 * Service factory — sole place adapters are wired.
 *
 * Route Handlers call getServices() to obtain singleton instances.
 * Swapping adapters (e.g. SQLite or Node orchestrator) only touches this file.
 */

import type {
  AudioService,
  ChunkStore,
  EpisodeStore,
  ExportService,
  LockManager,
  LogTailer,
  PipelineRunner,
  PreviewService,
  ProgressSource,
} from "./ports";

import {
  FileLogTailer,
  InMemoryLockManager,
  LegacyAudioService,
  LegacyChunkStore,
  LegacyEpisodeStore,
  LegacyExportService,
  LegacyPipelineRunner,
  LegacyPreviewService,
  StdoutProgressSource,
} from "./adapters/legacy";

export interface Services {
  episodes: EpisodeStore;
  chunks: ChunkStore;
  runner: PipelineRunner;
  locks: LockManager;
  progress: ProgressSource;
  logs: LogTailer;
  audio: AudioService;
  preview: PreviewService;
  export: ExportService;
}

let _services: Services | null = null;

/** Singleton accessor — all Route Handlers use this. */
export function getServices(): Services {
  if (_services) return _services;

  const locks = new InMemoryLockManager();
  const chunks = new LegacyChunkStore();
  const episodes = new LegacyEpisodeStore(chunks);
  const logs = new FileLogTailer();
  const progress = new StdoutProgressSource();
  const runner = new LegacyPipelineRunner(chunks, locks);
  const audio = new LegacyAudioService(chunks);
  const preview = new LegacyPreviewService();
  const exportSvc = new LegacyExportService();

  _services = {
    episodes,
    chunks,
    runner,
    locks,
    progress,
    logs,
    audio,
    preview,
    export: exportSvc,
  };

  return _services;
}

/** Test helper — replace or reset the singleton. */
export function _resetServices(services?: Services): void {
  _services = services ?? null;
}
