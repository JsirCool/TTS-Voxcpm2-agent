/**
 * Project root resolution + path helpers for legacy adapter.
 * Single source of truth for filesystem layout.
 */
import * as fs from "fs";
import * as path from "path";

let _cached: string | null = null;

/** Walk up from cwd until we find run.sh (project root). */
export function findRoot(): string {
  if (_cached) return _cached;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "run.sh"))) {
      _cached = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Cannot find project root (no run.sh found walking up from ${process.cwd()})`,
  );
}

export function workDir(epId: string): string {
  return path.join(findRoot(), ".work", epId);
}

export function chunksPath(epId: string): string {
  return path.join(workDir(epId), "chunks.json");
}

export function audioDir(epId: string): string {
  return path.join(workDir(epId), "audio");
}

export function runLogPath(epId: string): string {
  return path.join(workDir(epId), "run.log");
}

export function runningFlagPath(epId: string): string {
  return path.join(workDir(epId), ".running");
}

export function lastExitPath(epId: string): string {
  return path.join(workDir(epId), ".last_exit");
}

export function episodesDir(): string {
  return path.join(findRoot(), "episodes");
}

export function episodeScriptPath(epId: string): string {
  return path.join(episodesDir(), `${epId}.json`);
}

export function outputDir(epId: string): string {
  return path.join(workDir(epId), "output");
}

export function previewPath(epId: string): string {
  // P6/V2 stage outputs `preview.html` (see scripts/v2-preview.js)
  return path.join(workDir(epId), "preview.html");
}
