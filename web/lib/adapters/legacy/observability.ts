/**
 * Progress / log observability — parses run.log and .running flag.
 */
import * as fs from "fs";

import type { LogTailer, ProgressSource } from "@/lib/ports";
import type { EpisodeId } from "@/lib/types";

import { runLogPath, runningFlagPath } from "./paths";

/**
 * 解析 run.log 末尾,提取当前 stage 名 + 进度计数。
 *
 * 形如:
 *   === P2: TTS Synthesis (Fish TTS Agent) ===
 *   === P2: Synthesizing 10 chunk(s), concurrency=3, speed=1.15x ===
 *     [TTS] shot01_chunk01: "..."
 *       → shot01_chunk01.wav (4.20s)
 *
 * 期望输出: "P2 (1/10)"
 */
export class StdoutProgressSource implements ProgressSource {
  async getCurrentStage(epId: EpisodeId): Promise<string | null> {
    const p = runLogPath(epId);
    if (!fs.existsSync(p)) return null;

    // 只读末尾 ~64KB,避免读全文
    const stat = fs.statSync(p);
    const readSize = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const lines = buf.toString("utf-8").split("\n");

    // 倒序找最后一个 === Pn ... === marker
    let stageLineIdx = -1;
    let stageLabel: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/===\s+(P\d+(?:\.\d+)?)[^=]*===/);
      if (m) {
        stageLineIdx = i;
        stageLabel = m[1];
        break;
      }
      // 也接受 "=== Apply Pn ===" 这种 backend 自己写的
      const m2 = lines[i].match(/===\s+(?:Apply|Finalize|Retry)\s+(P\d+(?:\/P\d+)?)[^=]*===/);
      if (m2) {
        stageLineIdx = i;
        stageLabel = m2[1];
        break;
      }
    }
    if (!stageLabel) return null;

    // 从 stage 行向下扫描,统计该 stage 的进度
    const remaining = lines.slice(stageLineIdx + 1);

    // 估算 total: stage 行同段里若有 "Synthesizing N chunk" / "Transcribing N chunk"
    let total = 0;
    for (let i = stageLineIdx; i >= 0 && i >= stageLineIdx - 3; i--) {
      const line = lines[i] ?? "";
      const m =
        line.match(/Synthesizing\s+(\d+)\s+chunk/) ||
        line.match(/Transcribing\s+(\d+)\s+chunk/) ||
        line.match(/(\d+)\s+chunks?\s+to\s+process/i);
      if (m) {
        total = parseInt(m[1], 10);
        break;
      }
    }

    // 完成数:每个 "→ filename.wav" 算 1 次 P2 完成
    //         每个 "[TRANSCRIBE" 后的 "转写: ..." 算 1 次 P3 完成
    let done = 0;
    if (stageLabel.startsWith("P2")) {
      for (const line of remaining) {
        if (/→\s+\S+\.wav/.test(line)) done++;
      }
    } else if (stageLabel.startsWith("P3")) {
      for (const line of remaining) {
        if (/^\s*转写:/.test(line) || /\[TRANSCRIBE.*\]/.test(line)) {
          // 计数 [TRANSCRIBE 而不是"转写:",避免重复
          if (/^\s*\[TRANSCRIBE/.test(line)) done++;
        }
      }
    }

    if (total > 0) return `${stageLabel} ${done}/${total}`;
    if (done > 0) return `${stageLabel} (${done})`;
    return stageLabel;
  }

  async isRunning(epId: EpisodeId): Promise<boolean> {
    return fs.existsSync(runningFlagPath(epId));
  }
}

export class FileLogTailer implements LogTailer {
  async tail(epId: EpisodeId, lines: number): Promise<string[]> {
    const p = runLogPath(epId);
    if (!fs.existsSync(p)) return [];
    // 只读末尾 ~16KB,够 100 行
    const stat = fs.statSync(p);
    const readSize = Math.min(stat.size, Math.max(lines * 200, 16 * 1024));
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const all = buf.toString("utf-8").split("\n");
    return all.slice(-lines);
  }

  async clear(epId: EpisodeId): Promise<void> {
    const p = runLogPath(epId);
    if (fs.existsSync(p)) fs.writeFileSync(p, "");
  }
}
