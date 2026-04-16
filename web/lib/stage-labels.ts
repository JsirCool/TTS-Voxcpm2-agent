import type { StageName, StageStatus } from "./types";

export const STAGE_SHORT_LABEL: Record<StageName, string> = {
  p1: "切稿",
  p1c: "初检",
  p2: "配音",
  p2c: "校音",
  p2v: "复核",
  p5: "出字",
  p6: "拼轨",
  p6v: "总检",
};

export const STAGE_STATUS_LABEL: Record<StageStatus, string> = {
  pending: "等待中",
  running: "运行中",
  ok: "成功",
  failed: "失败",
};

export function getStageLabel(stage: StageName): string {
  return STAGE_SHORT_LABEL[stage];
}
