# TTS VoxCPM2 Agent Harness

本地优先的 TTS 生产工作台：把脚本、文本、B 站视频或本地音视频素材，变成可审核、可重跑、可导出的配音、字幕和 Remotion 时间轴素材。

Local-first TTS production harness for turning scripts, pasted text, Bilibili links, or local media clips into reviewable voiceover, subtitles, and Remotion-friendly exports.

> 当前版本默认使用 **本地 VoxCPM2 + 本地 WhisperX**，面向 Windows 本地工作流，不依赖云端 TTS 或云端 ASR 服务。

## Highlights

| 能力 | 说明 |
|---|---|
| 本地配音 | 通过本地 `VoxCPM2` HTTP 服务完成 `声音设计 / 可控克隆 / 极致克隆` |
| 本地复核 | 通过本地 `WhisperX` 做 ASR、字幕、复核和字幕选段 |
| 素材处理 | 支持本地 `mp4 / mov / mkv / mp3 / wav / m4a`，也支持 B 站公开视频链接导入 |
| 字幕选段 | 优先使用 B 站原生字幕；没有原生字幕时，用户确认后再启用 WhisperX 自动转写 |
| 返工工作台 | 支持按 chunk 快捷重跑、Take 历史、人工确认复核、批量处理 |
| Remotion 导出 | 导出 `shot*.wav`、`episode.wav`、`episode.srt`、`remotion-manifest.json` |

## Architecture

```text
Browser
  -> Next.js Web (:3010)
  -> FastAPI API (:8100)
      -> Prefect tasks
      -> PostgreSQL + MinIO
      -> local voxcpm-svc (:8877)
      -> local whisperx-svc (:7860)
```

Pipeline stage labels used in the UI:

| Stage | UI label | Meaning |
|---|---|---|
| `P1` | `切稿` | script splitting |
| `P1c` | `初检` | initial validation |
| `P2` | `配音` | voice synthesis |
| `P2c` | `校音` | audio validation |
| `P2v` | `复核` | ASR verification |
| `P5` | `出字` | subtitle generation |
| `P6` | `拼轨` | final audio concat |
| `P6v` | `总检` | final validation |

## What Is Not Included In Git

This repository stores source code, scripts, config templates, and docs only. Large local runtime assets are intentionally not committed.

Do not upload these to GitHub:

- Python virtual environments, for example `E:\VC\venv312`
- Hugging Face / WhisperX cache, for example `E:\VC\hf-cache`
- VoxCPM2 model files, for example `E:\VC\pretrained_models\VoxCPM2`
- local reference audio under `voice_sourse`
- logs, storage mirrors, export caches, `node_modules`, and frontend build output

Each user must prepare these assets locally before running the full stack.

## Quick Start On Windows

Required software:

- Docker Desktop
- Python `3.12`
- Node.js `18+`
- `pnpm`
- `ffmpeg` and `ffprobe`

Clone and create your local environment file:

```powershell
git clone https://github.com/JsirCool/TTS-Voxcpm2-agent.git
cd TTS-Voxcpm2-agent
copy .env.dev .env
```

Install dependencies into one shared Python environment:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .\server[dev]
.\.venv\Scripts\python.exe -m pip install -e .\voxcpm-svc
.\.venv\Scripts\python.exe -m pip install -e .\whisperx-svc[dev]
pnpm --dir .\web install
```

Then edit these two files:

- `.env`
- `scripts/windows/_env.bat`

At minimum, check:

- `VENV_PY`
- `VOXCPM_MODEL_PATH`
- `HF_HOME`
- `VOXCPM_URL`
- `WHISPERX_URL`
- `NEXT_PUBLIC_API_URL`

If your machine does not use a proxy, clear or remove:

- `HTTP_PROXY`
- `HTTPS_PROXY`

Start everything:

```powershell
.\start-local-stack.bat
```

The launcher starts Docker infra, runs migrations, starts VoxCPM / WhisperX / API / Web in the background, and opens:

```text
http://localhost:3010
```

Stop everything:

```powershell
.\stop-local-stack.bat
```

For visible service windows and logs, use:

```powershell
.\start-local-stack-debug.bat
```

For the detailed Windows guide, see [WINDOWS-START.md](WINDOWS-START.md).

## Local Paths

Reference audio paths are stored as relative paths and resolved from `voice_sourse`.

Recommended layout:

```text
E:\VC\tts-agent-harness
E:\VC\voice_sourse
```

Example:

```json
{
  "reference_audio_path": "111.m4a"
}
```

Resolves to:

```text
E:\VC\voice_sourse\111.m4a
```

The directory name is intentionally kept as `voice_sourse` for compatibility with existing local data.

## TTS Modes

| Mode | Use case | Required fields |
|---|---|---|
| `声音设计 / Voice Design` | Create a voice from text instructions only | `control_prompt` |
| `可控克隆 / Controllable Cloning` | Keep speaker timbre, optionally control style | `reference_audio_path`, optional `control_prompt` |
| `极致克隆 / Ultimate Cloning` | Continue from a prompt clip with high detail | `prompt_audio_path`, `prompt_text` |

Parameter isolation is enforced before synthesis:

- `声音设计` clears audio reference fields.
- `可控克隆` clears `prompt_audio_path` and `prompt_text`.
- `极致克隆` clears `reference_audio_path` and `control_prompt`.
- Per-chunk overrides do not leak into incompatible modes.

For `极致克隆`, the most important stability factor is exact alignment between the prompt audio and `prompt_text`. In the media dialog, `15s` is treated as the recommended range and `40s` as the hard limit.

## New Episode Input

You can create an Episode in two ways:

1. Upload a `script.json`.
2. Paste plain text and let the app convert it into internal JSON.

Minimal script format:

```json
{
  "title": "Episode Title",
  "segments": [
    { "id": 1, "type": "hook", "text": "第一段旁白。" },
    { "id": 2, "type": "content", "text": "第二段旁白。" }
  ]
}
```

`segment` is the human-facing shot unit. The system splits each segment into smaller synthesis chunks.

## Media-To-Clone Workflow

Open `素材处理` next to `TTS 配置`.

Supported inputs:

- local files: `mp4`, `mov`, `mkv`, `mp3`, `wav`, `m4a`
- public Bilibili links: `bilibili.com/video/BV...`, `bilibili.com/video/av...`, `b23.tv/...`

Workflow:

1. Import local media or paste a Bilibili link.
2. Preview the media.
3. Resolve subtitles:
   - Bilibili native subtitles are used first when available.
   - If native subtitles are missing, the UI asks before running WhisperX.
   - WhisperX uses auto language detection; Chinese remains Chinese, English remains English.
4. Select a continuous subtitle range or manually adjust start/end time.
5. Name the voice asset, for example `小A的声音`.
6. Choose cleanup:
   - `轻量稳定 / light`: ffmpeg trim, mono, resample, loudness normalization, light denoise.
   - `重度人声分离 / vocal_isolate`: Demucs vocal isolation, then normalization.
7. Preview:
   - original selected clip
   - processed voice asset
   - fixed trial synthesis sample
8. Apply to the current Episode only after you are satisfied.

Generated voice assets are saved under:

```text
voice_sourse/assets/<voice-name>/
```

Bilibili source cache is saved under:

```text
voice_sourse/imported/bilibili/
```

Current Bilibili v1 limitations:

- public videos only
- no login cookies
- no VIP / paid / protected content
- no livestreams
- no playlist or collection batch import

## Export Format

Exports include both per-shot files and final assembled files:

```text
episode.zip/
  shot01.wav
  shot02.wav
  ...
  episode.wav
  episode.srt
  subtitles.json
  durations.json
  remotion-manifest.json
```

`remotion-manifest.json` contains timing metadata such as shot order, start/end time, frames, audio file names, and subtitle cues.

You can also export to a local directory from the UI.

## Common URLs

| Service | URL |
|---|---|
| Web | `http://localhost:3010` |
| API | `http://localhost:8100` |
| API docs | `http://localhost:8100/docs` |
| VoxCPM health | `http://127.0.0.1:8877/healthz` |
| WhisperX health | `http://127.0.0.1:7860/healthz` |
| MinIO console | `http://localhost:59001` |
| Prefect | `http://localhost:54200` |

## Useful Commands

Run backend tests:

```powershell
.\.venv\Scripts\python.exe -m pytest .\server\tests -q
```

Type-check the frontend:

```powershell
pnpm --dir .\web exec tsc --noEmit
```

Check local API health:

```powershell
curl http://127.0.0.1:8100/healthz
curl http://127.0.0.1:8100/readyz
```

## Troubleshooting

| Symptom | What to check |
|---|---|
| Web loads but Episode fetch fails | API on `8100` is probably down. Open `http://127.0.0.1:8100/healthz`. |
| VoxCPM errors during synthesis | Check mode fields. `极致克隆` needs accurate `prompt_text`; try `可控克隆` for longer or noisy samples. |
| WhisperX subtitle fallback is slow | This is expected for long media. The UI asks before starting WhisperX because it can take time. |
| Docker containers seem missing | `stop-local-stack.bat` now uses `stop`, not `down`; containers should remain visible as `Exited`. |
| Bilibili import fails | Only public videos are supported. Private, paid, login-only, and VIP content are out of scope for v1. |

## Third-Party Notice

This repository includes a minimal adapted subset of Bilibili import logic derived from `Bili23 Downloader`.

See:

- [third_party/bili23/NOTICE.md](third_party/bili23/NOTICE.md)

Because of this source integration, the repository is distributed under a GPL-3.0 compatible license.

## License

GPL-3.0
