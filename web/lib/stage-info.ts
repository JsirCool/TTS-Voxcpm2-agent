import type { StageName } from "./types";

export interface StageInfo {
  title: string;
  description: string;
  inputs: string;
  outputs: string;
  failure: string;
}

export const STAGE_INFO: Record<StageName, StageInfo> = {
  p1: {
    title: "P1 · 脚本切分",
    description: "把 script.json 里的 segments 切成可独立处理的 chunks。",
    inputs: "script.json (MinIO)",
    outputs: "chunks 列表 (DB)",
    failure: "script.json 格式错误 / MinIO 读取失败",
  },
  p1c: {
    title: "P1c · 输入校验",
    description: "在进入合成前校验 chunk 文本和结构是否合法。",
    inputs: "chunks 列表 (DB)",
    outputs: "校验通过 / 错误报告",
    failure: "chunk 文本为空 / 字段缺失 / 数据格式不合法",
  },
  p2: {
    title: "P2 · VoxCPM 合成",
    description: "调用本地 VoxCPM 服务，把 chunk.text_normalized 合成为 WAV 音频。",
    inputs: "chunk.textNormalized + episode.config",
    outputs: "WAV 音频 (MinIO) + take 记录 (DB)",
    failure: "VoxCPM 服务离线 / 模型未加载 / 本地参考音频路径无效",
  },
  p2c: {
    title: "P2c · 音频格式校验",
    description: "校验生成后的 WAV 是否完整可读，再进入转写环节。",
    inputs: "take WAV (MinIO)",
    outputs: "校验通过 / 错误报告",
    failure: "WAV 损坏 / 采样率异常 / 文件为空",
  },
  p2v: {
    title: "P2v · WhisperX 验证",
    description: "调用本地 WhisperX 做转写，并检查语速与静音异常。",
    inputs: "take WAV + chunk.textNormalized",
    outputs: "transcript.json (MinIO) + 质量评分",
    failure: "WhisperX 不可用 / 转写失败 / 语速或静音异常",
  },
  p5: {
    title: "P5 · 字幕生成",
    description: "根据 WhisperX 的 word timestamps 生成逐句字幕和时间轴。",
    inputs: "transcript.json + chunk.subtitleText / chunk.text",
    outputs: "subtitle.srt (MinIO)",
    failure: "transcript 为空 / 无 selected_take / 字幕源文本无效",
  },
  p6: {
    title: "P6 · 音频拼接",
    description: "按 shot 顺序拼接所有 chunk 音频，并合并字幕。",
    inputs: "所有 chunk 的 take WAV + subtitle SRT",
    outputs: "final/episode.wav + final/episode.srt (MinIO)",
    failure: "缺少 selected_take / ffmpeg 失败 / MinIO 写入失败",
  },
  p6v: {
    title: "P6v · 成片校验",
    description: "校验最终音频和字幕的完整性、覆盖率与时间对齐。",
    inputs: "final/episode.wav + final/episode.srt",
    outputs: "校验通过 / 错误报告",
    failure: "字幕覆盖率不足 / 时间戳 gap 或 overlap 过大",
  },
};
