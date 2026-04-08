/**
 * Legacy Episode / Chunk store backed by filesystem (.work/<ep>/chunks.json).
 */
import * as fs from "fs";
import * as path from "path";

import type {
  ChunkStore,
  EpisodeStore,
} from "@/lib/ports";
import type {
  Chunk,
  ChunkId,
  EditBatch,
  Episode,
  EpisodeId,
  EpisodeStatus,
  EpisodeSummary,
  Take,
  TakeId,
} from "@/lib/types";
import { DomainError } from "@/lib/types";

import {
  chunksPath,
  episodeScriptPath,
  episodesDir,
  lastExitPath,
  outputDir,
  runningFlagPath,
  workDir,
  findRoot,
} from "./paths";
import {
  chunkToRaw,
  rawChunksFileSchema,
  rawToChunk,
  takeToRaw,
  type RawChunk,
} from "./chunks-schema";

// ────────────────────────────────────────────────────────────────
// Episode store
// ────────────────────────────────────────────────────────────────

export class LegacyEpisodeStore implements EpisodeStore {
  constructor(private chunks: LegacyChunkStore) {}

  async list(): Promise<EpisodeSummary[]> {
    const root = findRoot();
    const workRoot = path.join(root, ".work");
    const epRoot = path.join(root, "episodes");

    // 联合 .work/ 子目录 和 episodes/ 下的 script 文件,
    // 任一存在都算一个 episode
    const ids = new Set<string>();

    if (fs.existsSync(workRoot)) {
      for (const d of fs.readdirSync(workRoot, { withFileTypes: true })) {
        if (d.isDirectory()) ids.add(d.name);
      }
    }

    if (fs.existsSync(epRoot)) {
      for (const f of fs.readdirSync(epRoot)) {
        // 优先匹配历史格式 script-<id>.json
        let m = f.match(/^script-([a-zA-Z0-9_-]+)\.json$/);
        if (m) {
          ids.add(m[1]);
          continue;
        }
        // 新格式 <id>.json (排除 script- 前缀)
        m = f.match(/^([a-zA-Z0-9_-]+)\.json$/);
        if (m && !m[1].startsWith("script-")) ids.add(m[1]);
      }
    }

    const out: EpisodeSummary[] = [];
    for (const id of ids) {
      const status = this.inferStatus(id);
      const scriptMissing = !fs.existsSync(episodeScriptPath(id));
      let chunkCount = 0;
      let updatedAt = new Date(0).toISOString();
      const cp = chunksPath(id);
      try {
        if (fs.existsSync(cp)) {
          const stat = fs.statSync(cp);
          updatedAt = stat.mtime.toISOString();
          const raw = JSON.parse(fs.readFileSync(cp, "utf-8"));
          if (Array.isArray(raw)) chunkCount = raw.length;
        } else {
          const wd = workDir(id);
          if (fs.existsSync(wd)) {
            updatedAt = fs.statSync(wd).mtime.toISOString();
          } else if (!scriptMissing) {
            // 全新 episode:还没 .work,用 script 文件 mtime
            const sp = episodeScriptPath(id);
            if (fs.existsSync(sp)) {
              updatedAt = fs.statSync(sp).mtime.toISOString();
            }
          }
        }
      } catch {
        // ignore parse errors in list view
      }
      out.push({
        id,
        status,
        currentStage: null,
        chunkCount,
        updatedAt,
        metadata: scriptMissing ? { scriptMissing: true } : {},
      });
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async get(id: EpisodeId): Promise<Episode | null> {
    const wd = workDir(id);
    const sp = episodeScriptPath(id);
    const hasWork = fs.existsSync(wd);
    const hasScript = fs.existsSync(sp);

    // 既无 work 也无 script → 真不存在
    if (!hasWork && !hasScript) return null;

    const status = this.inferStatus(id);
    const cp = chunksPath(id);

    let chunks: Chunk[] = [];
    let updatedAt = new Date().toISOString();
    let createdAt = updatedAt;

    if (fs.existsSync(cp)) {
      const stat = fs.statSync(cp);
      updatedAt = stat.mtime.toISOString();
      createdAt = stat.birthtime.toISOString();
      const raw = JSON.parse(fs.readFileSync(cp, "utf-8"));
      const parsed = rawChunksFileSchema.parse(raw);
      chunks = parsed.map((r, i) => rawToChunk(r, i + 1));
    } else if (hasWork) {
      const s = fs.statSync(wd);
      updatedAt = s.mtime.toISOString();
      createdAt = s.birthtime.toISOString();
    } else {
      // 只有 script,没 work
      const s = fs.statSync(sp);
      updatedAt = s.mtime.toISOString();
      createdAt = s.birthtime.toISOString();
    }

    const totalDurationS = chunks.reduce((acc, c) => {
      const t = c.takes.find((t) => t.id === c.selectedTakeId);
      return acc + (t?.durationS ?? 0);
    }, 0);

    const scriptMissing = !fs.existsSync(episodeScriptPath(id));

    return {
      id,
      status,
      currentStage: null,
      chunks,
      totalDurationS,
      createdAt,
      updatedAt,
      metadata: scriptMissing ? { scriptMissing: true } : {},
    };
  }

  async create(id: EpisodeId, scriptJson: unknown): Promise<Episode> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new DomainError(
        `invalid episode id: ${id}`,
        "invalid_input",
      );
    }
    const epDir = episodesDir();
    fs.mkdirSync(epDir, { recursive: true });
    const scriptPath = episodeScriptPath(id);
    fs.writeFileSync(scriptPath, JSON.stringify(scriptJson, null, 2));

    const wd = workDir(id);
    fs.mkdirSync(wd, { recursive: true });

    const now = new Date().toISOString();
    return {
      id,
      status: "ready",
      currentStage: null,
      chunks: [],
      totalDurationS: 0,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };
  }

  async delete(id: EpisodeId): Promise<void> {
    const wd = workDir(id);
    if (fs.existsSync(wd)) fs.rmSync(wd, { recursive: true, force: true });
    const sp = episodeScriptPath(id);
    if (fs.existsSync(sp)) fs.unlinkSync(sp);
  }

  // ── helpers ──

  private inferStatus(id: EpisodeId): EpisodeStatus {
    const wd = workDir(id);
    const sp = episodeScriptPath(id);
    const hasScript = fs.existsSync(sp);

    // 没 work 没 script → 完全空
    if (!fs.existsSync(wd)) {
      return hasScript ? "ready" : "empty";
    }

    const cp = chunksPath(id);
    // 有 work 但没 chunks.json → ready (script 存在) 或 empty
    if (!fs.existsSync(cp)) {
      return hasScript ? "ready" : "empty";
    }

    if (fs.existsSync(runningFlagPath(id))) return "running";

    const le = lastExitPath(id);
    if (fs.existsSync(le)) {
      const code = fs.readFileSync(le, "utf-8").trim();
      if (code !== "0") return "failed";
    }

    const od = outputDir(id);
    if (fs.existsSync(od)) {
      const files = fs.readdirSync(od).filter((f) => f.endsWith(".wav"));
      if (files.length > 0) return "done";
    }
    return "ready";
  }
}

// ────────────────────────────────────────────────────────────────
// Chunk store (with per-episode write queue)
// ────────────────────────────────────────────────────────────────

export class LegacyChunkStore implements ChunkStore {
  private queues = new Map<string, Promise<unknown>>();

  private withWriteLock<T>(
    epId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.queues.get(epId) ?? Promise.resolve();
    const next = prev.then(fn, fn) as Promise<T>;
    this.queues.set(
      epId,
      next.catch(() => undefined),
    );
    return next;
  }

  async get(epId: EpisodeId, cid: ChunkId): Promise<Chunk | null> {
    const cp = chunksPath(epId);
    if (!fs.existsSync(cp)) return null;
    const raw = JSON.parse(fs.readFileSync(cp, "utf-8"));
    const parsed = rawChunksFileSchema.parse(raw);
    const idx = parsed.findIndex((c) => c.id === cid);
    if (idx < 0) return null;
    return rawToChunk(parsed[idx], idx + 1);
  }

  private readRaw(epId: EpisodeId): RawChunk[] {
    const cp = chunksPath(epId);
    if (!fs.existsSync(cp)) {
      throw new DomainError(
        `chunks.json not found for episode ${epId}`,
        "not_found",
      );
    }
    const raw = JSON.parse(fs.readFileSync(cp, "utf-8"));
    return rawChunksFileSchema.parse(raw);
  }

  private writeAtomic(epId: EpisodeId, data: RawChunk[]): void {
    const cp = chunksPath(epId);
    // backup
    if (fs.existsSync(cp)) {
      const bak = `${cp}.v${Date.now()}.json`;
      try {
        fs.copyFileSync(cp, bak);
      } catch {
        // non-fatal
      }
    }
    const tmp = `${cp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, cp);
  }

  async applyEdits(epId: EpisodeId, edits: EditBatch): Promise<void> {
    return this.withWriteLock(epId, async () => {
      const data = this.readRaw(epId);
      for (const [cid, edit] of Object.entries(edits)) {
        const idx = data.findIndex((c) => c.id === cid);
        if (idx < 0) continue;
        const chunk = data[idx];
        if (edit.textNormalized !== undefined) {
          chunk.text_normalized = edit.textNormalized;
          chunk.status = "pending";
          chunk.file = null;
          chunk.duration_s = undefined;
          chunk.takes = undefined;
          chunk.selected_take_id = null;
        }
        if (edit.subtitleText !== undefined) {
          chunk.subtitle_text = edit.subtitleText;
        }
        data[idx] = chunk;
      }
      this.writeAtomic(epId, data);
    });
  }

  async appendTake(
    epId: EpisodeId,
    cid: ChunkId,
    take: Take,
  ): Promise<void> {
    return this.withWriteLock(epId, async () => {
      const data = this.readRaw(epId);
      const idx = data.findIndex((c) => c.id === cid);
      if (idx < 0) {
        throw new DomainError(`chunk ${cid} not found`, "not_found");
      }
      const chunk = data[idx];
      const takes = chunk.takes ?? [];
      takes.push(takeToRaw(take));
      chunk.takes = takes;
      if (!chunk.selected_take_id) chunk.selected_take_id = take.id;
      data[idx] = chunk;
      this.writeAtomic(epId, data);
    });
  }

  async selectTake(
    epId: EpisodeId,
    cid: ChunkId,
    takeId: TakeId,
  ): Promise<void> {
    return this.withWriteLock(epId, async () => {
      const data = this.readRaw(epId);
      const idx = data.findIndex((c) => c.id === cid);
      if (idx < 0) {
        throw new DomainError(`chunk ${cid} not found`, "not_found");
      }
      const chunk = data[idx];
      const takes = chunk.takes ?? [];
      const t = takes.find((tk) => tk.id === takeId);
      if (!t) {
        throw new DomainError(`take ${takeId} not found`, "not_found");
      }
      chunk.selected_take_id = takeId;
      // 同步"当前生效文件"到 legacy 字段,P5/P6 读 file
      chunk.file = t.file;
      chunk.duration_s = t.duration_s;
      data[idx] = chunk;
      this.writeAtomic(epId, data);
    });
  }

  async removeTake(
    epId: EpisodeId,
    cid: ChunkId,
    takeId: TakeId,
  ): Promise<void> {
    return this.withWriteLock(epId, async () => {
      const data = this.readRaw(epId);
      const idx = data.findIndex((c) => c.id === cid);
      if (idx < 0) {
        throw new DomainError(`chunk ${cid} not found`, "not_found");
      }
      const chunk = data[idx];
      const takes = (chunk.takes ?? []).filter((t) => t.id !== takeId);
      chunk.takes = takes;
      if (chunk.selected_take_id === takeId) {
        chunk.selected_take_id = takes[0]?.id ?? null;
        if (takes[0]) {
          chunk.file = takes[0].file;
          chunk.duration_s = takes[0].duration_s;
        } else {
          chunk.file = null;
          chunk.duration_s = undefined;
        }
      }
      data[idx] = chunk;
      this.writeAtomic(epId, data);
    });
  }
}

// Re-export for internal callers that want Chunk→Raw helpers
export { chunkToRaw };
