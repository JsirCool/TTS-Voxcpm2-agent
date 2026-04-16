import type { StageName } from "./types";
import { STAGE_SHORT_LABEL } from "./stage-labels";

export interface StageInfo {
  title: string;
  description: string;
  inputs: string;
  outputs: string;
  failure: string;
}

export const STAGE_INFO: Record<StageName, StageInfo> = {
  p1: {
    title: STAGE_SHORT_LABEL.p1,
    description: "把 script.json 里的 segments 拆成可独立执行的 chunk。",
    inputs: "script.json（MinIO）",
    outputs: "chunks 列表（数据库）",
    failure: "脚本 JSON 格式错误，或存储读取失败。",
  },
  p1c: {
    title: STAGE_SHORT_LABEL.p1c,
    description: "在进入配音前检查 chunk 文本和结构是否合法。",
    inputs: "chunks 列表（数据库）",
    outputs: "通过 / 阻断报告",
    failure: "文本为空、字段缺失，或控制标记异常。",
  },
  p2: {
    title: STAGE_SHORT_LABEL.p2,
    description: "调用本地 VoxCPM，把文本合成为 WAV 音频并生成 take。",
    inputs: "chunk.textNormalized + episode.config",
    outputs: "WAV 音频（MinIO）+ take 记录",
    failure: "VoxCPM 不可用、模型未加载，或参考音频路径无效。",
  },
  p2c: {
    title: STAGE_SHORT_LABEL.p2c,
    description: "检查生成后的 WAV 是否完整、可读、格式正确。",
    inputs: "take WAV（MinIO）",
    outputs: "通过 / 格式错误报告",
    failure: "WAV 损坏、采样率异常，或文件为空。",
  },
  p2v: {
    title: STAGE_SHORT_LABEL.p2v,
    description: "调用本地 WhisperX 做转写，并检查语速与静音异常。",
    inputs: "take WAV + chunk.textNormalized",
    outputs: "transcript + 质量评分",
    failure: "WhisperX 不可用、转写失败，或质量门槛未通过。",
  },
  p5: {
    title: STAGE_SHORT_LABEL.p5,
    description: "根据 WhisperX 时间轴生成字幕和分段时间信息。",
    inputs: "transcript + subtitleText / text",
    outputs: "subtitle.srt（MinIO）",
    failure: "缺少 transcript、selected take，或字幕源文本异常。",
  },
  p6: {
    title: STAGE_SHORT_LABEL.p6,
    description: "按 shot 顺序拼接所有 chunk 音频，并合并字幕。",
    inputs: "所有 verified chunk 的 take WAV + 字幕",
    outputs: "final/episode.wav + final/episode.srt",
    failure: "缺少 selected take、ffmpeg 失败，或存储写入失败。",
  },
  p6v: {
    title: STAGE_SHORT_LABEL.p6v,
    description: "检查成片音频、字幕覆盖率和时间对齐是否完整。",
    inputs: "final/episode.wav + final/episode.srt",
    outputs: "通过 / 总检报告",
    failure: "字幕覆盖率不足，或时间轴 gap / overlap 过大。",
  },
};
