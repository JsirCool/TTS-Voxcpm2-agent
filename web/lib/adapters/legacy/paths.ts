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

/**
 * Find the script file for an episode.
 * Tries new format `<id>.json` first, falls back to legacy `script-<id>.json`.
 * Returns the canonical path even if the file doesn't exist (callers check fs.existsSync).
 */
export function episodeScriptPath(epId: string): string {
  const dir = episodesDir();
  const newPath = path.join(dir, `${epId}.json`);
  if (fs.existsSync(newPath)) return newPath;
  const legacyPath = path.join(dir, `script-${epId}.json`);
  if (fs.existsSync(legacyPath)) return legacyPath;
  // Default to new format for create()
  return newPath;
}

export function outputDir(epId: string): string {
  return path.join(workDir(epId), "output");
}

export function previewPath(epId: string): string {
  // P6/V2 stage outputs `preview.html` (see scripts/v2-preview.js)
  return path.join(workDir(epId), "preview.html");
}

// ────────────────────────────────────────────────────────────────
// .env loader
// ────────────────────────────────────────────────────────────────
//
// Loads <root>/.env into a plain object,merge into spawn env so
// child processes inherit FISH_TTS_KEY etc.
// Cached after first call.

let _envCache: Record<string, string> | null = null;

export function loadDotenv(): Record<string, string> {
  if (_envCache) return _envCache;
  const envPath = path.join(findRoot(), ".env");
  const out: Record<string, string> = {};
  if (!fs.existsSync(envPath)) {
    _envCache = out;
    return out;
  }
  const text = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    let val = m[2].trim();
    // strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // strip inline comment (# preceded by space)
    const hashIdx = val.indexOf(" #");
    if (hashIdx >= 0) val = val.slice(0, hashIdx).trim();
    out[m[1]] = val;
  }
  _envCache = out;
  return out;
}

/** Merge .env into process.env shape for spawn() */
export function spawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...loadDotenv() };
}
