# TTS Agent Harness

一个把 `script.json` 批量转成配音音频、字幕和导出包的本地生产工具。

这个分支已经从 `Fish Audio S2-Pro + Groq` 改成：

- TTS: 本地 `VoxCPM` 服务
- ASR / 验证: 本地 `WhisperX` 服务

## 架构

```text
Browser -> Next.js (3010) -> FastAPI (8100) -> Prefect Tasks
                                             -> PostgreSQL + MinIO
                                             -> local voxcpm-svc
                                             -> local whisperx-svc
```

Pipeline: `P1 -> P1c -> P2 -> P2c -> P2v -> P5 -> P6 -> P6v`

## 运行前提

- Docker
- Node.js 18+
- Python 3.11+ for the harness server
- Python 3.12 + CUDA-ready VoxCPM environment for `voxcpm-svc`
- `ffmpeg` / `ffprobe`

## 快速开始

```bash
# 1. 基础设施
make dev

# 2. 环境变量
cp .env.dev .env

# 3. 数据库迁移
make migrate

# 4. 启动本地 WhisperX
#   参考仓库里的 whisperx-svc/server.py

# 5. 启动本地 VoxCPM
#   参考仓库里的 voxcpm-svc/server.py

# 6. 启动 API + Web
make serve-api
make serve-web
```

默认页面地址：`http://localhost:3010`

## 本地服务

### VoxCPM

`P2` 不再直接导入 GPU 模型，而是通过本地 HTTP 服务调用 VoxCPM。这样可以复用已经部署好的 CUDA 环境，而不用把整个 harness server 也绑到同一个 Python / Torch 环境里。

服务文件：

- `voxcpm-svc/server.py`
- `server/core/voxcpm_client.py`

默认地址：

- `VOXCPM_URL=http://127.0.0.1:8877`

### WhisperX

`P2v` / `P3` 默认只走本地 WhisperX：

- `WHISPERX_URL=http://127.0.0.1:7860`

不再依赖 Groq API key。

## Episode TTS 配置

当前支持的主要字段：

- `cfg_value`
- `inference_timesteps`
- `control_prompt`
- `reference_audio_path`
- `prompt_audio_path`
- `prompt_text`
- `normalize`
- `denoise`

示例：

```json
{
  "title": "Episode Title",
  "tts_config": {
    "cfg_value": 2.0,
    "inference_timesteps": 10,
    "control_prompt": "young female voice, warm and gentle",
    "reference_audio_path": "E:\\audio\\speaker.wav",
    "normalize": false,
    "denoise": false
  },
  "segments": [
    { "id": 1, "type": "hook", "text": "要朗读的文本" }
  ]
}
```

说明：

- `control_prompt` 会自动拼成 `(control_prompt)正文`
- `reference_audio_path` 用于参考音色克隆
- `prompt_audio_path + prompt_text` 用于高保真续写

## 环境变量

核心变量：

- `VOXCPM_URL`
- `VOXCPM_MODEL_PATH`
- `VOXCPM_DEVICE`
- `VOXCPM_CFG_VALUE`
- `VOXCPM_INFERENCE_TIMESTEPS`
- `WHISPERX_URL`
- `DATABASE_URL`
- `MINIO_ENDPOINT`

参考模板见 `.env.dev`。

## 导出格式

```text
episode.zip/
  shot01.wav, shot02.wav, ...
  subtitles.json
  durations.json
```

## 技术栈

- TTS: VoxCPM (local)
- ASR: WhisperX (local)
- Backend: FastAPI + Prefect + SQLAlchemy
- Frontend: Next.js 16 + Zustand + Tailwind CSS
- Storage: PostgreSQL + MinIO

## 测试

```bash
cd server && python -m pytest tests/ -x
cd web && npx tsc --noEmit
```

## License

MIT
