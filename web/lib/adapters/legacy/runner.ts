/**
 * LegacyPipelineRunner — spawns run.sh and individual pipeline scripts.
 */
import { spawn, execSync, type ChildProcess } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import type {
  ChunkStore,
  LockHandle,
  LockManager,
  PipelineRunner,
} from "@/lib/ports";
import type {
  ChunkId,
  EditBatch,
  EpisodeId,
  JobId,
  JobStatus,
  OperationResult,
} from "@/lib/types";
import { DomainError } from "@/lib/types";

import {
  audioDir,
  chunksPath,
  episodeScriptPath,
  findRoot,
  lastExitPath,
  runLogPath,
  runningFlagPath,
  spawnEnv,
  workDir,
} from "./paths";

interface Job {
  id: JobId;
  episodeId: EpisodeId;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  child: ChildProcess | null;
}

export class LegacyPipelineRunner implements PipelineRunner {
  private jobs = new Map<JobId, Job>();

  constructor(
    private chunks: ChunkStore,
    private locks: LockManager,
  ) {}

  // ────────────────────────────────────────────────
  // spawn helper
  // ────────────────────────────────────────────────

  private spawnAndWait(
    cmd: string,
    args: string[],
    logFile: string,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const root = findRoot();
      const child = spawn(cmd, args, { cwd: root, env: spawnEnv() });
      child.stdout.on("data", (d) => {
        try {
          fs.appendFileSync(logFile, d);
        } catch {}
      });
      child.stderr.on("data", (d) => {
        try {
          fs.appendFileSync(logFile, d);
        } catch {}
      });
      child.on("exit", (code) => resolve(code ?? -1));
      child.on("error", (err) => reject(err));
    });
  }

  private prepareWork(epId: EpisodeId): {
    wd: string;
    runningFile: string;
    lastExit: string;
    logFile: string;
  } {
    const wd = workDir(epId);
    fs.mkdirSync(wd, { recursive: true });
    const runningFile = runningFlagPath(epId);
    const lastExit = lastExitPath(epId);
    const logFile = runLogPath(epId);
    fs.writeFileSync(runningFile, "");
    if (fs.existsSync(lastExit)) fs.unlinkSync(lastExit);
    return { wd, runningFile, lastExit, logFile };
  }

  private finalize(
    job: Job,
    runningFile: string,
    lastExit: string,
    code: number,
    handle: LockHandle,
    error?: string,
  ) {
    try {
      if (fs.existsSync(runningFile)) fs.unlinkSync(runningFile);
    } catch {}
    try {
      fs.writeFileSync(lastExit, String(code));
    } catch {}
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    if (error) job.error = error;
    handle.release().catch(() => undefined);
  }

  // ────────────────────────────────────────────────
  // runFull
  // ────────────────────────────────────────────────

  async runFull(
    epId: EpisodeId,
    _options?: { mode?: "fresh" | "text-only"; force?: boolean },
  ): Promise<OperationResult> {
    // Pre-flight: ensure script.json exists, otherwise run.sh will explode
    if (!fs.existsSync(episodeScriptPath(epId))) {
      throw new DomainError(
        `script not found for episode ${epId} (episodes/${epId}.json missing). ` +
          `This episode has runtime data in .work/ but no source script — orphan episode.`,
        "invalid_state",
      );
    }

    const handle = await this.locks.acquire(
      { type: "global" },
      `runFull:${epId}`,
    );
    const { runningFile, lastExit, logFile } = this.prepareWork(epId);

    const jobId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const job: Job = {
      id: jobId,
      episodeId: epId,
      startedAt,
      finishedAt: null,
      exitCode: null,
      error: null,
      child: null,
    };
    this.jobs.set(jobId, job);

    const root = findRoot();
    // Resolve actual script path (new or legacy naming) → make relative to root
    const scriptAbs = episodeScriptPath(epId);
    const scriptRel = path.relative(root, scriptAbs);

    try {
      const child = spawn("bash", ["run.sh", scriptRel, epId], {
        cwd: root,
        env: spawnEnv(),
      });
      job.child = child;
      child.stdout.on("data", (d) => {
        try {
          fs.appendFileSync(logFile, d);
        } catch {}
      });
      child.stderr.on("data", (d) => {
        try {
          fs.appendFileSync(logFile, d);
        } catch {}
      });
      child.on("exit", (code) => {
        this.finalize(job, runningFile, lastExit, code ?? -1, handle);
      });
      child.on("error", (err) => {
        this.finalize(
          job,
          runningFile,
          lastExit,
          -1,
          handle,
          err.message,
        );
      });
    } catch (err) {
      this.finalize(
        job,
        runningFile,
        lastExit,
        -1,
        handle,
        (err as Error).message,
      );
      throw err;
    }

    return { jobId, startedAt };
  }

  // ────────────────────────────────────────────────
  // applyEdits
  // ────────────────────────────────────────────────

  async applyEdits(
    epId: EpisodeId,
    edits: EditBatch,
  ): Promise<OperationResult> {
    const handle = await this.locks.acquire(
      { type: "global" },
      `applyEdits:${epId}`,
    );
    const { runningFile, lastExit, logFile } = this.prepareWork(epId);

    const jobId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const job: Job = {
      id: jobId,
      episodeId: epId,
      startedAt,
      finishedAt: null,
      exitCode: null,
      error: null,
      child: null,
    };
    this.jobs.set(jobId, job);

    // 1. Write chunks.json (awaited synchronously before async pipeline)
    try {
      await this.chunks.applyEdits(epId, edits);
    } catch (e) {
      this.finalize(
        job,
        runningFile,
        lastExit,
        -1,
        handle,
        (e as Error).message,
      );
      throw e;
    }

    const hasTtsDirty = Object.values(edits).some(
      (e) => e.textNormalized !== undefined,
    );

    // 2. Run async
    (async () => {
      try {
        const wd = workDir(epId);
        if (hasTtsDirty) {
          fs.appendFileSync(logFile, `\n=== Apply P2 ===\n`);
          const c2 = await this.spawnAndWait(
            "node",
            [
              "scripts/p2-synth.js",
              "--chunks",
              chunksPath(epId),
              "--outdir",
              audioDir(epId),
              "--trace",
              path.join(wd, "trace.jsonl"),
            ],
            logFile,
          );
          if (c2 !== 0) throw new Error(`p2 exit ${c2}`);

          fs.appendFileSync(logFile, `\n=== Apply P3 ===\n`);
          const c3 = await this.spawnAndWait(
            "python",
            [
              "scripts/p3-transcribe.py",
              "--chunks",
              chunksPath(epId),
              "--audiodir",
              audioDir(epId),
              "--outdir",
              path.join(wd, "transcripts"),
              "--server-url",
              "http://127.0.0.1:5555",
            ],
            logFile,
          );
          if (c3 !== 0) throw new Error(`p3 exit ${c3}`);
        }
        fs.appendFileSync(logFile, `\n=== Apply P5/P6 ===\n`);
        const c5 = await this.spawnAndWait(
          "bash",
          ["run.sh", path.relative(findRoot(), episodeScriptPath(epId)), epId, "--from", "p5"],
          logFile,
        );
        if (c5 !== 0) throw new Error(`run.sh --from p5 exit ${c5}`);

        this.finalize(job, runningFile, lastExit, 0, handle);
      } catch (e) {
        fs.appendFileSync(
          logFile,
          `\n[apply] ERROR: ${(e as Error).message}\n`,
        );
        this.finalize(
          job,
          runningFile,
          lastExit,
          -1,
          handle,
          (e as Error).message,
        );
      }
    })();

    return { jobId, startedAt };
  }

  // ────────────────────────────────────────────────
  // retryChunk
  // ────────────────────────────────────────────────

  async retryChunk(
    epId: EpisodeId,
    cid: ChunkId,
    options: { count: number; params?: Record<string, unknown> },
  ): Promise<OperationResult> {
    const handle = await this.locks.acquire(
      { type: "chunk", episodeId: epId, chunkId: cid },
      `retry:${cid}`,
    );

    const chunk = await this.chunks.get(epId, cid);
    if (!chunk) {
      handle.release().catch(() => undefined);
      throw new DomainError(`chunk ${cid} not found`, "not_found");
    }

    const wd = workDir(epId);
    fs.mkdirSync(wd, { recursive: true });
    fs.mkdirSync(audioDir(epId), { recursive: true });
    const runningFile = runningFlagPath(epId);
    const lastExit = lastExitPath(epId);
    const logFile = runLogPath(epId);
    // retry does NOT clear lastExit (it's a side operation)
    fs.writeFileSync(runningFile, "");

    const jobId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const job: Job = {
      id: jobId,
      episodeId: epId,
      startedAt,
      finishedAt: null,
      exitCode: null,
      error: null,
      child: null,
    };
    this.jobs.set(jobId, job);

    (async () => {
      try {
        for (let i = 0; i < options.count; i++) {
          const takeId = `take_${Date.now()}_${i}`;
          const tmpChunksPath = path.join(
            wd,
            `chunks-retry-${takeId}.json`,
          );
          const tmpAudioDir = path.join(wd, `audio-retry-${takeId}`);
          fs.mkdirSync(tmpAudioDir, { recursive: true });

          const tmpChunk = {
            id: chunk.id,
            shot_id: chunk.shotId,
            text: chunk.text,
            text_normalized: chunk.textNormalized,
            char_count: chunk.charCount,
            status: "pending" as const,
          };
          fs.writeFileSync(tmpChunksPath, JSON.stringify([tmpChunk]));

          fs.appendFileSync(logFile, `\n=== Retry ${cid} #${i + 1} ===\n`);
          const code = await this.spawnAndWait(
            "node",
            [
              "scripts/p2-synth.js",
              "--chunks",
              tmpChunksPath,
              "--outdir",
              tmpAudioDir,
              "--chunk",
              cid,
            ],
            logFile,
          );
          if (code !== 0) {
            fs.appendFileSync(
              logFile,
              `\n[retry] ${takeId} failed (exit ${code})\n`,
            );
            try {
              fs.unlinkSync(tmpChunksPath);
            } catch {}
            try {
              fs.rmSync(tmpAudioDir, { recursive: true, force: true });
            } catch {}
            continue;
          }

          // candidate wav filenames: p2-synth writes <cid>.wav or similar.
          // Pick first .wav we find in tmpAudioDir to be robust.
          let srcWav = path.join(tmpAudioDir, `${cid}.wav`);
          if (!fs.existsSync(srcWav)) {
            const wavs = fs
              .readdirSync(tmpAudioDir)
              .filter((f) => f.endsWith(".wav"));
            if (wavs.length === 0) {
              fs.appendFileSync(
                logFile,
                `\n[retry] ${takeId} no wav produced\n`,
              );
              continue;
            }
            srcWav = path.join(tmpAudioDir, wavs[0]);
          }

          const dstFile = `${cid}.${takeId}.wav`;
          const dstPath = path.join(audioDir(epId), dstFile);
          fs.renameSync(srcWav, dstPath);

          let durationS = 0;
          try {
            const out = execSync(
              `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${dstPath}"`,
              { encoding: "utf-8" },
            );
            durationS = parseFloat(out.trim()) || 0;
          } catch {}

          await this.chunks.appendTake(epId, cid, {
            id: takeId,
            file: dstFile,
            durationS,
            createdAt: new Date().toISOString(),
            params: options.params,
          });

          try {
            fs.unlinkSync(tmpChunksPath);
          } catch {}
          try {
            fs.rmSync(tmpAudioDir, { recursive: true, force: true });
          } catch {}
        }
        try {
          if (fs.existsSync(runningFile)) fs.unlinkSync(runningFile);
        } catch {}
        job.exitCode = 0;
        job.finishedAt = new Date().toISOString();
        handle.release().catch(() => undefined);
      } catch (e) {
        fs.appendFileSync(
          logFile,
          `\n[retry] ERROR: ${(e as Error).message}\n`,
        );
        try {
          if (fs.existsSync(runningFile)) fs.unlinkSync(runningFile);
        } catch {}
        try {
          fs.writeFileSync(lastExit, "-1");
        } catch {}
        job.exitCode = -1;
        job.finishedAt = new Date().toISOString();
        job.error = (e as Error).message;
        handle.release().catch(() => undefined);
      }
    })();

    return { jobId, startedAt };
  }

  // ────────────────────────────────────────────────
  // finalizeTake
  // ────────────────────────────────────────────────

  async finalizeTake(
    epId: EpisodeId,
    cid: ChunkId,
  ): Promise<OperationResult> {
    const handle = await this.locks.acquire(
      { type: "global" },
      `finalize:${cid}`,
    );
    const { runningFile, lastExit, logFile } = this.prepareWork(epId);

    const chunk = await this.chunks.get(epId, cid);
    if (!chunk) {
      this.locks.acquire; // no-op
      handle.release().catch(() => undefined);
      throw new DomainError(`chunk ${cid} not found`, "not_found");
    }

    const jobId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const job: Job = {
      id: jobId,
      episodeId: epId,
      startedAt,
      finishedAt: null,
      exitCode: null,
      error: null,
      child: null,
    };
    this.jobs.set(jobId, job);

    (async () => {
      try {
        const wd = workDir(epId);
        fs.appendFileSync(logFile, `\n=== Finalize P3 ${cid} ===\n`);
        const c3 = await this.spawnAndWait(
          "python",
          [
            "scripts/p3-transcribe.py",
            "--chunks",
            chunksPath(epId),
            "--audiodir",
            audioDir(epId),
            "--outdir",
            path.join(wd, "transcripts"),
            "--server-url",
            "http://127.0.0.1:5555",
            "--chunk",
            cid,
          ],
          logFile,
        );
        if (c3 !== 0) throw new Error(`p3 exit ${c3}`);

        fs.appendFileSync(logFile, `\n=== Finalize P5/P6 ===\n`);
        const c5 = await this.spawnAndWait(
          "bash",
          ["run.sh", path.relative(findRoot(), episodeScriptPath(epId)), epId, "--from", "p5"],
          logFile,
        );
        if (c5 !== 0) throw new Error(`run.sh --from p5 exit ${c5}`);

        this.finalize(job, runningFile, lastExit, 0, handle);
      } catch (e) {
        fs.appendFileSync(
          logFile,
          `\n[finalize] ERROR: ${(e as Error).message}\n`,
        );
        this.finalize(
          job,
          runningFile,
          lastExit,
          -1,
          handle,
          (e as Error).message,
        );
      }
    })();

    return { jobId, startedAt };
  }

  // ────────────────────────────────────────────────
  // cancel / getJobStatus
  // ────────────────────────────────────────────────

  async cancel(jobId: JobId): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.child && typeof job.child.kill === "function") {
      try {
        job.child.kill("SIGTERM");
      } catch {}
    }
  }

  async getJobStatus(jobId: JobId): Promise<JobStatus> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new DomainError(`job ${jobId} not found`, "not_found");
    }
    let state: JobStatus["state"];
    if (job.exitCode === null) state = "running";
    else if (job.exitCode === 0) state = "done";
    else state = "failed";
    return {
      id: job.id,
      state,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      error: job.error,
      episodeId: job.episodeId,
    };
  }
}
