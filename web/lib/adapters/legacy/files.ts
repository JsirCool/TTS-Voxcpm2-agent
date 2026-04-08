/**
 * File services — audio / preview / export
 */
import * as fs from "fs";
import * as path from "path";

import type {
  AudioService,
  ChunkStore,
  ExportResult,
  ExportService,
  PreviewService,
} from "@/lib/ports";
import type { ChunkId, EpisodeId, ShotId, TakeId } from "@/lib/types";
import { DomainError } from "@/lib/types";

import {
  audioDir,
  outputDir,
  previewPath,
  workDir,
} from "./paths";

export class LegacyAudioService implements AudioService {
  constructor(private chunks: ChunkStore) {}

  async getTakeFile(
    epId: EpisodeId,
    cid: ChunkId,
    takeId?: TakeId,
  ): Promise<string> {
    const chunk = await this.chunks.get(epId, cid);
    if (!chunk) {
      throw new DomainError(`chunk ${cid} not found`, "not_found");
    }
    const tid = takeId ?? chunk.selectedTakeId;
    if (!tid) {
      throw new DomainError(
        `no take selected for chunk ${cid}`,
        "not_found",
      );
    }
    const take = chunk.takes.find((t) => t.id === tid);
    if (!take) {
      throw new DomainError(`take ${tid} not found`, "not_found");
    }
    const filePath = path.join(audioDir(epId), take.file);
    if (!fs.existsSync(filePath)) {
      throw new DomainError(
        `audio file missing: ${filePath}`,
        "not_found",
      );
    }
    return filePath;
  }

  async getShotFile(epId: EpisodeId, shotId: ShotId): Promise<string> {
    const od = outputDir(epId);
    const candidate = path.join(od, `${shotId}.wav`);
    if (!fs.existsSync(candidate)) {
      throw new DomainError(
        `shot file missing: ${candidate}`,
        "not_found",
      );
    }
    return candidate;
  }
}

export class LegacyPreviewService implements PreviewService {
  async getPreviewFile(epId: EpisodeId): Promise<string> {
    const p = previewPath(epId);
    if (!fs.existsSync(p)) {
      throw new DomainError(`preview not found: ${p}`, "not_found");
    }
    return p;
  }
}

export class LegacyExportService implements ExportService {
  async exportTo(
    epId: EpisodeId,
    targetDir: string,
  ): Promise<ExportResult> {
    if (!targetDir) {
      throw new DomainError("targetDir required", "invalid_input");
    }
    fs.mkdirSync(targetDir, { recursive: true });

    let filesCopied = 0;
    let totalBytes = 0;

    const copyFile = (src: string, dst: string) => {
      fs.copyFileSync(src, dst);
      filesCopied++;
      totalBytes += fs.statSync(dst).size;
    };

    const od = outputDir(epId);
    if (fs.existsSync(od)) {
      for (const name of fs.readdirSync(od)) {
        if (name.endsWith(".wav")) {
          copyFile(path.join(od, name), path.join(targetDir, name));
        }
      }
      const durations = path.join(od, "durations.json");
      if (fs.existsSync(durations)) {
        copyFile(durations, path.join(targetDir, "durations.json"));
      }
    }

    const subs = path.join(workDir(epId), "subtitles.json");
    if (fs.existsSync(subs)) {
      copyFile(subs, path.join(targetDir, "subtitles.json"));
    }

    return { filesCopied, totalBytes };
  }
}
