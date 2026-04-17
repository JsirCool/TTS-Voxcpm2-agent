# TTS Agent Harness

本项目是一个本地生产工具，用来把 `script.json` 或直接输入的文本转成配音、字幕和 Remotion 友好的导出素材。

This project is a local production tool that turns `script.json` or pasted text into voiceover, subtitles, and Remotion-friendly export assets.

当前分支已经从旧的 `Fish Audio + Groq` 方案改成：

This branch has already been migrated away from the old `Fish Audio + Groq` setup and now uses:

- TTS: local `VoxCPM` service
- ASR / verification: local `WhisperX` service

## 架构 / Architecture

```text
Browser -> Next.js (3010) -> FastAPI (8100) -> Prefect Tasks
                                             -> PostgreSQL + MinIO
                                             -> local voxcpm-svc
                                             -> local whisperx-svc
```

Pipeline:

```text
P1 -> P1c -> P2 -> P2c -> P2v -> P5 -> P6 -> P6v
```

前端展示中的中文短词对应：

The short Chinese labels shown in the UI map to:

- `P1` -> `切稿`
- `P1c` -> `初检`
- `P2` -> `配音`
- `P2c` -> `校音`
- `P2v` -> `复核`
- `P5` -> `出字`
- `P6` -> `拼轨`
- `P6v` -> `总检`

## 仓库不包含的内容 / What Is Not Included In Git

GitHub 仓库只保存源码、脚本、配置模板和文档，不包含本地运行资产。

The GitHub repository contains source code, scripts, config templates, and docs only. It does not include local runtime assets.

这些内容必须由每台机器自己准备，且不应该上传到 Git：

The following assets must be prepared locally on each machine and should not be committed:

- Python virtual environments such as `E:\VC\venv312`
- Hugging Face / WhisperX cache such as `E:\VC\hf-cache`
- VoxCPM model files such as `E:\VC\pretrained_models\VoxCPM2`
- local reference audio files under `voice_sourse`
- local logs, export cache, storage mirrors, and build output

## 必须自备的本地资源 / Required Local Assets

在第一次启动前，请确认这些资源已经准备好：

Before first startup, make sure these local assets are available:

1. Docker Desktop
2. Node.js `18+`
3. `pnpm`
4. Python `3.12`
5. `ffmpeg` and `ffprobe`
6. a working local Python runtime for the harness server and services
7. a local VoxCPM model directory
8. a local Hugging Face / WhisperX cache

如果要使用“可控克隆”或“极致克隆”，还需要准备参考音频。

If you want to use controllable cloning or ultimate cloning, you also need local reference audio.

## 安装依赖 / Install Dependencies

最简单的方式，是准备一个统一的 Python 3.12 环境，并让 `scripts/windows/_env.bat` 里的 `VENV_PY` 指向这个环境。

The simplest setup is to prepare one shared Python 3.12 environment and point `VENV_PY` in `scripts/windows/_env.bat` to that environment.

示例：

Example:

```powershell
cd E:\VC\tts-agent-harness
python -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -e .\server[dev]
.venv\Scripts\python.exe -m pip install -e .\voxcpm-svc
.venv\Scripts\python.exe -m pip install -e .\whisperx-svc[dev]
pnpm --dir .\web install
```

然后把 `_env.bat` 里的 `VENV_PY` 改成：

Then update `VENV_PY` in `_env.bat` to:

```text
E:\VC\tts-agent-harness\.venv\Scripts\python.exe
```

说明：

Notes:

- `server` 是 API / workflow / database 相关依赖
- `voxcpm-svc` 是本地 TTS HTTP 服务
- `whisperx-svc` 是本地 ASR / verification HTTP 服务
- `web` 使用 `pnpm`
- 如果你的 VoxCPM / WhisperX 需要特殊 CUDA / Torch 组合，请按你的机器环境调整，但一键启动脚本默认仍然只会读取一个 `VENV_PY`

- `server` contains the API, workflow, and database dependencies
- `voxcpm-svc` is the local TTS HTTP service
- `whisperx-svc` is the local ASR / verification HTTP service
- `web` uses `pnpm`
- If your VoxCPM / WhisperX setup requires a special CUDA / Torch combination, adjust it for your machine, but note that the current one-click launcher still reads a single `VENV_PY`

## 参考音频目录 / Reference Audio Directory

当前项目把 `reference_audio_path` 和 `prompt_audio_path` 视为相对路径，默认相对于仓库上一级的 `voice_sourse` 目录解析。

This project treats `reference_audio_path` and `prompt_audio_path` as relative paths. By default, they are resolved relative to the `voice_sourse` directory located one level above the repository.

例如：

For example:

```text
E:\VC\tts-agent-harness
E:\VC\voice_sourse
```

如果配置里写的是：

If your config says:

```json
{
  "reference_audio_path": "111.m4a"
}
```

实际会解析到：

It will resolve to:

```text
E:\VC\voice_sourse\111.m4a
```

说明：目录名当前保持为 `voice_sourse`，是为了兼容现有实现和历史数据。

Note: the directory name is intentionally kept as `voice_sourse` for compatibility with the current implementation and existing data.

## 最短启动步骤 / Shortest Startup Path

如果你是 Windows 用户，最短启动步骤如下：

If you are on Windows, the shortest startup path is:

1. Clone the repository.
2. Copy `.env.dev` to `.env`.
3. Edit `.env` and `scripts/windows/_env.bat`.
4. Make sure your local paths are correct.
5. Double-click `start-local-stack.bat`.
6. Open `http://localhost:3010`.

PowerShell 示例：

PowerShell example:

```powershell
git clone <your-repo-url>
cd tts-agent-harness
copy .env.dev .env
```

启动前至少检查这几个值：

At minimum, verify these values before startup:

- `.env`
  - `VOXCPM_MODEL_PATH`
  - `VOXCPM_URL`
  - `WHISPERX_URL`
  - `DATABASE_URL`
  - `MINIO_ENDPOINT`
- `scripts/windows/_env.bat`
  - `VENV_PY`
  - `HF_HOME`
  - `WEB_PM`

如果你的机器不使用代理，请清空或删除：

If your machine does not use an HTTP proxy, clear or remove:

- `HTTP_PROXY`
- `HTTPS_PROXY`

## Windows 一键启动 / Windows One-Click Start

直接双击：

Double-click:

- [start-local-stack.bat](/E:/VC/tts-agent-harness/start-local-stack.bat)

它会执行：

It will:

1. start Docker infra: Postgres + MinIO
2. run Alembic migrations
3. check Web dependencies
4. open separate windows for:
   - VoxCPM
   - WhisperX
   - API
   - Web
5. open the browser at `http://localhost:3010`

停止时双击：

To stop everything, double-click:

- [stop-local-stack.bat](/E:/VC/tts-agent-harness/stop-local-stack.bat)

如果你想看到启动过程中卡在哪一步，不要直接双击，而是运行：

If you want to keep the startup window open for debugging, run:

```powershell
cmd /k E:\VC\tts-agent-harness\start-local-stack.bat
```

## 单独启动服务 / Start Services Individually

你也可以只启动某一个服务：

You can also start a single service only:

- [scripts/windows/run-voxcpm-svc.bat](/E:/VC/tts-agent-harness/scripts/windows/run-voxcpm-svc.bat)
- [scripts/windows/run-whisperx-svc.bat](/E:/VC/tts-agent-harness/scripts/windows/run-whisperx-svc.bat)
- [scripts/windows/run-api.bat](/E:/VC/tts-agent-harness/scripts/windows/run-api.bat)
- [scripts/windows/run-web.bat](/E:/VC/tts-agent-harness/scripts/windows/run-web.bat)

## 本地服务说明 / Local Services

### VoxCPM

`P2` 不再直接在 harness server 里加载模型，而是通过本地 HTTP 服务调用 `VoxCPM`。

`P2` no longer loads the model directly inside the harness server. It calls a local `VoxCPM` HTTP service instead.

默认地址：

Default endpoint:

- `VOXCPM_URL=http://127.0.0.1:8877`

相关文件：

Relevant files:

- [voxcpm-svc/server.py](/E:/VC/tts-agent-harness/voxcpm-svc/server.py)
- [server/core/voxcpm_client.py](/E:/VC/tts-agent-harness/server/core/voxcpm_client.py)

### WhisperX

`P2v` 和 `P3` 默认走本地 WhisperX 服务。

`P2v` and `P3` use a local WhisperX service by default.

默认地址：

Default endpoint:

- `WHISPERX_URL=http://127.0.0.1:7860`

## TTS 配置 / TTS Configuration

当前主要字段：

Main fields:

- `cfg_value`
- `inference_timesteps`
- `control_prompt`
- `reference_audio_path`
- `prompt_audio_path`
- `prompt_text`
- `normalize`
- `denoise`

三种常见模式：

Three common modes:

1. `声音设计 / Voice Design`
   - only `control_prompt`
2. `可控克隆 / Controllable Cloning`
   - `reference_audio_path` plus optional `control_prompt`
3. `极致克隆 / Ultimate Cloning`
   - `prompt_audio_path` + `prompt_text`

示例：

Example:

```json
{
  "title": "Episode Title",
  "tts_config": {
    "cfg_value": 2.0,
    "inference_timesteps": 10,
    "control_prompt": "young female voice, warm and gentle",
    "reference_audio_path": "111.m4a",
    "normalize": false,
    "denoise": false
  },
  "segments": [
    { "id": 1, "type": "hook", "text": "要朗读的文本" }
  ]
}
```

## 导出格式 / Export Format

导出结果现在同时包含按 shot 拆分的音频，以及整集拼接完成的音频和字幕。

Exports now include both per-shot audio files and the final concatenated episode audio and subtitle.

```text
episode.zip/
  shot01.wav, shot02.wav, ...
  episode.wav
  episode.srt
  subtitles.json
  durations.json
  remotion-manifest.json
```

其中：

Where:

- `shotXX.wav` is per-shot audio
- `episode.wav` is the fully concatenated episode audio
- `episode.srt` is the merged final subtitle file
- `remotion-manifest.json` contains Remotion-friendly timing metadata

## 常用地址 / Common URLs

- Web: `http://localhost:3010`
- API: `http://localhost:8100`
- API docs: `http://localhost:8100/docs`
- VoxCPM health: `http://127.0.0.1:8877/healthz`
- WhisperX health: `http://127.0.0.1:7860/healthz`
- MinIO console: `http://localhost:59001`

## 测试 / Tests

```powershell
cd server
python -m pytest tests/ -x

cd ..\web
pnpm exec tsc --noEmit
```

## License

MIT
