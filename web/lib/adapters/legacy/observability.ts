/**
 * Progress / log observability — parses run.log and .running flag.
 */
import * as fs from "fs";

import type { LogTailer, ProgressSource } from "@/lib/ports";
import type { EpisodeId } from "@/lib/types";

import { runLogPath, runningFlagPath } from "./paths";

export class StdoutProgressSource implements ProgressSource {
  async getCurrentStage(epId: EpisodeId): Promise<string | null> {
    const p = runLogPath(epId);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p, "utf-8");
    const lines = buf.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/=== ([^=]+) ===/);
      if (m) return m[1].trim();
    }
    return null;
  }

  async isRunning(epId: EpisodeId): Promise<boolean> {
    return fs.existsSync(runningFlagPath(epId));
  }
}

export class FileLogTailer implements LogTailer {
  async tail(epId: EpisodeId, lines: number): Promise<string[]> {
    const p = runLogPath(epId);
    if (!fs.existsSync(p)) return [];
    const buf = fs.readFileSync(p, "utf-8");
    const all = buf.split("\n");
    return all.slice(-lines);
  }

  async clear(epId: EpisodeId): Promise<void> {
    const p = runLogPath(epId);
    if (fs.existsSync(p)) fs.writeFileSync(p, "");
  }
}
