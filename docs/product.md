# TTS Agent Harness Product Overview / 产品概览

## Positioning / 产品定位

TTS Agent Harness is a local production tool for turning scripts into voiceover, subtitles, and Remotion-friendly export assets.

TTS Agent Harness 是一个本地生产工具，用来把脚本转换成配音、字幕和适合 Remotion 使用的导出素材。

It is designed for workflows where creators need to repeatedly synthesize, review, fix, and export narration at chunk level instead of manually juggling API calls and temporary files.

它面向这样一种工作流：创作者需要以 chunk 为单位反复合成、试听、修正、重跑和导出，而不是手工管理 API 调用与零散临时文件。

## Target Users / 目标用户

- video creators
- podcasters
- short-form narration teams
- creators using Remotion as the downstream editor

- 视频创作者
- 播客制作人
- 短视频口播团队
- 使用 Remotion 作为下游编辑器的创作者

## Supported Runtime / 支持的运行方式

The current repository officially supports local operation only.

当前仓库官方只支持本地运行。

Main components:

- Browser / Next.js UI
- FastAPI API
- local VoxCPM service
- local WhisperX service
- local Postgres + MinIO + Prefect via Docker Compose

主要组件包括：

- 浏览器 / Next.js 界面
- FastAPI API
- 本地 VoxCPM 服务
- 本地 WhisperX 服务
- 通过 Docker Compose 启动的本地 Postgres + MinIO + Prefect

## Core Flow / 核心流程

```text
Import script -> Split into chunks -> Synthesize -> Verify -> Edit / Retry -> Generate subtitles -> Export
```

UI stage labels:

- `切稿` = `P1`
- `初检` = `P1c`
- `配音` = `P2`
- `校音` = `P2c`
- `复核` = `P2v`
- `出字` = `P5`
- `拼轨` = `P6`
- `总检` = `P6v`

## Input Model / 输入模型

The tool accepts either:

- `script.json`
- pasted text that is converted internally into the episode JSON structure

工具当前支持两种输入：

- `script.json`
- 直接输入文本，由系统内部转换成 episode JSON

Each episode is organized into `segments`, and each segment is split into executable `chunks`.

每个 episode 先按 `segments` 组织，再继续切成可执行的 `chunks`。

## Key Features / 关键能力

### 1. Local TTS and verification / 本地配音与复核

- local VoxCPM for synthesis
- local WhisperX for ASR-based verification
- per-chunk retry
- per-chunk `Control Prompt` override for supported modes

- 本地 VoxCPM 合成
- 本地 WhisperX 回写复核
- 支持按 chunk 重跑
- 在支持的模式下，可为每个 chunk 单独覆盖 `Control Prompt`

### 2. Review workflow / 审核返工工作流

- abnormal-chunk workbench
- quick retry buttons beside each chunk
- inline diff-style context between source text and ASR result
- take history and take switching

- 异常 chunk 工作台
- 每条 chunk 旁边的快捷重跑
- 原文与 ASR 回写的对照上下文
- take 历史与切换

### 3. TTS presets / TTS 预设

- project presets
- global presets
- default preset for new episodes
- import / export presets

- 项目预设
- 全局预设
- 新建 episode 默认预设
- 预设导入 / 导出

### 4. Export / 导出

Exports are designed for downstream editing and Remotion use.

导出结果面向下游编辑和 Remotion 使用。

Current export bundle includes:

- per-shot WAV files such as `shot01.wav`
- final combined audio `episode.wav`
- final subtitle file `episode.srt`
- `durations.json`
- `subtitles.json`
- `remotion-manifest.json`

当前导出包包含：

- 按 shot 拆分的 WAV，例如 `shot01.wav`
- 整集拼接音频 `episode.wav`
- 整集字幕文件 `episode.srt`
- `durations.json`
- `subtitles.json`
- `remotion-manifest.json`

## Architecture Snapshot / 架构概览

```text
Browser -> Next.js (3010) -> FastAPI (8100) -> task pipeline
                                             -> PostgreSQL + MinIO
                                             -> local voxcpm-svc
                                             -> local whisperx-svc
```

## Storage Model / 存储模型

- PostgreSQL stores metadata
- MinIO stores generated audio, subtitles, and scripts
- `storage-mirror` can mirror object storage to a local visible directory
- `voice_sourse` stores local reference audio used for cloning

- PostgreSQL 存元数据
- MinIO 存生成出的音频、字幕和脚本
- `storage-mirror` 可把对象存储镜像到本地可见目录
- `voice_sourse` 存放用于克隆的本地参考音频

## Non-Goals / 非目标

The repository no longer treats managed cloud deployment as part of the default product story.

当前仓库不再把托管云部署视为默认产品路径的一部分。

## Known Constraints / 已知限制

- model files and caches must be prepared locally
- local paths are machine-specific and need local configuration
- Windows remains the primary documented path
- audio quality still depends on source text, prompt quality, and model behavior

- 模型文件与缓存需要自行准备
- 本地路径与机器环境绑定，需要本地配置
- 当前文档主要围绕 Windows 路径编写
- 实际配音质量仍受文本、prompt 和模型行为影响
