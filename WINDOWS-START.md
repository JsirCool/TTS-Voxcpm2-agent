# Windows Local Start / Windows 本地启动

## 1. 适用场景 / What This Guide Is For

这份文档用于 Windows 本地开发环境，帮助你快速启动整套 `tts-agent-harness`。

This guide is for local Windows development and explains how to start the full `tts-agent-harness` stack.

## 2. 启动前必须准备 / Required Before Startup

请先安装：

Install these first:

- Docker Desktop
- Node.js `18+`
- `pnpm`
- Python `3.12`
- `ffmpeg` and `ffprobe`

另外还需要准备这些本地资产：

You also need these local assets:

- a local Python runtime for the harness services
- a local VoxCPM model directory
- a local Hugging Face / WhisperX cache
- optional local reference audio files under `voice_sourse`

## 3. 先改这两个文件 / Edit These Two Files First

首次启动前，请先检查：

Before your first run, check:

- [`.env.dev`](/E:/VC/tts-agent-harness/.env.dev)
- [`scripts/windows/_env.bat`](/E:/VC/tts-agent-harness/scripts/windows/_env.bat)

通常你需要确认这几个值：

Usually you need to confirm these values:

- `VENV_PY`
- `VOXCPM_MODEL_PATH`
- `HF_HOME`
- `VOXCPM_URL`
- `WHISPERX_URL`

如果你的机器不用代理，请清空 `.env` 里的：

If your machine does not use a proxy, clear these values in `.env`:

- `HTTP_PROXY`
- `HTTPS_PROXY`

## 4. 创建 `.env` / Create `.env`

如果仓库根目录还没有 `.env`，复制模板：

If the repo root does not yet contain `.env`, copy the template:

```powershell
copy .env.dev .env
```

## 5. 安装依赖 / Install Dependencies

最简单的方式，是准备一个统一的 Python 3.12 环境，并让启动脚本都指向同一个 `python.exe`。

The simplest setup is to prepare one shared Python 3.12 environment and let all launcher scripts use the same `python.exe`.

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

然后把：

Then point:

- [`scripts/windows/_env.bat`](/E:/VC/tts-agent-harness/scripts/windows/_env.bat)

里的 `VENV_PY` 改成：

Set `VENV_PY` to:

```text
E:\VC\tts-agent-harness\.venv\Scripts\python.exe
```

如果你的 VoxCPM / WhisperX 依赖特殊 CUDA / Torch 组合，也可以自己拆成多个环境，但那时就需要自己修改启动脚本。

If your VoxCPM / WhisperX setup depends on a special CUDA / Torch combination, you can split them into multiple environments, but then you must customize the launcher scripts yourself.

## 6. 一键启动 / One-Click Start

直接双击：

Double-click:

- [start-local-stack.bat](/E:/VC/tts-agent-harness/start-local-stack.bat)

它会自动执行：

It will automatically:

1. start Docker infra: Postgres + MinIO
2. run Alembic migrations
3. check or install Web dependencies
4. start VoxCPM / WhisperX / API / Web in the background
5. open the browser at `http://localhost:3010`

榛樿鐨勪竴閿惎鍔ㄧ幇鍦ㄦ槸鍚庡彴闈欓粯妯″紡锛屼笉鍐嶅脊鍑?4 涓湇鍔＄獥鍙ｃ€?
The default one-click launcher now starts services silently in the background, without opening four terminal windows.

## 7. 一键停止 / One-Click Stop

双击：

Double-click:

- [stop-local-stack.bat](/E:/VC/tts-agent-harness/stop-local-stack.bat)

它会停止：

It will stop:

- local processes on ports `3010`, `7860`, `8100`, `8877`
- Docker infra for this project

## 8. 调试模式启动 / Debug Startup Mode

如果你双击后觉得“窗口一闪而过”，并不一定是脚本坏了。主启动脚本本来就会在拉起服务窗口后结束。

If the window closes immediately after double-clicking, that does not always mean the script failed. The launcher is designed to exit after it starts the service windows.

如果你想看到它卡在哪一步，请运行：

If you want to keep the launcher window open and see where it stops, run:

```powershell
cmd /k E:\VC\tts-agent-harness\start-local-stack.bat
```

濡傛灉浣犻渶瑕佺湅鍒版瘡涓湇鍔＄殑鍙鏃ュ織绐楀彛锛岃鐢細
If you want visible service windows for troubleshooting, use:

```powershell
cmd /k E:\VC\tts-agent-harness\start-local-stack-debug.bat
```

## 9. 单独启动某个服务 / Start a Single Service

你也可以只启动某个服务：

You can also start a single service:

- [scripts/windows/run-voxcpm-svc.bat](/E:/VC/tts-agent-harness/scripts/windows/run-voxcpm-svc.bat)
- [scripts/windows/run-whisperx-svc.bat](/E:/VC/tts-agent-harness/scripts/windows/run-whisperx-svc.bat)
- [scripts/windows/run-api.bat](/E:/VC/tts-agent-harness/scripts/windows/run-api.bat)
- [scripts/windows/run-web.bat](/E:/VC/tts-agent-harness/scripts/windows/run-web.bat)

## 10. 常用地址 / Common URLs

- Web: `http://localhost:3010`
- API: `http://localhost:8100`
- API docs: `http://localhost:8100/docs`
- VoxCPM health: `http://127.0.0.1:8877/healthz`
- WhisperX health: `http://127.0.0.1:7860/healthz`
- MinIO console: `http://localhost:59001`

## 11. 参考音频目录 / Reference Audio Folder

如果你要使用可控克隆或极致克隆，请把参考音频放到 `voice_sourse` 目录。

If you want to use controllable cloning or ultimate cloning, put your reference audio files in the `voice_sourse` directory.

默认目录通常是仓库的上一级：

By default, this directory is usually placed one level above the repo:

```text
E:\VC\tts-agent-harness
E:\VC\voice_sourse
```

配置里填写相对路径即可，例如：

Use relative paths in the config, for example:

```text
111.m4a
speakers\host-a.wav
```

## 12. 视频/音频转克隆素材 / Video Or Audio To Clone Source

前端现在新增了 `素材处理` 弹窗，入口就在 `TTS 配置` 旁边。
The Web UI now includes a `素材处理` dialog next to `TTS 配置`.

它支持导入：
Supported local inputs:

- `mp4`
- `mov`
- `mkv`
- `mp3`
- `wav`
- `m4a`

你可以在弹窗里完成：
Inside the dialog you can:

- 预览本地视频或音频
- 选择开始和结束时间
- 选择 `轻量稳定` 或 `重度人声分离`
- 选择套用到 `可控克隆` 或 `极致克隆`

依赖说明：
Dependencies:

- 基础处理必须有：`ffmpeg` 和 `ffprobe`
- `重度人声分离` 额外需要：本地 `Demucs`
- `极致克隆` 自动生成 `prompt_text` 还需要：本地 `WhisperX` 正常可用

输出说明：
Output behavior:

- 输出始终为 `WAV`
- 文件会写到 `voice_sourse/imported/`
- 套用到当前 Episode 时会自动做模式互斥，不会把旧字段叠进去

## 13. 首次启动注意事项 / First-Run Notes

- WhisperX 第一次加载模型时，可能需要 `10-60` 秒。
- Web 依赖安装当前默认使用 `pnpm`。
- 如果 Web 没打开，先确认 `http://localhost:3010` 是否能访问。
- 如果端口被占用，先运行停止脚本再重试。

- WhisperX may take `10-60` seconds to load on first run.
- Web dependencies are currently installed with `pnpm`.
- If the Web app does not open, first check whether `http://localhost:3010` is reachable.
- If a port is already in use, run the stop script and try again.

## 14. 常见问题 / Common Problems

### 找不到 Python / Missing Python

请修改：

Edit:

- [`scripts/windows/_env.bat`](/E:/VC/tts-agent-harness/scripts/windows/_env.bat)

并确认：

And verify:

- `VENV_PY` points to your local `python.exe`

### VoxCPM 启动了但模型没加载 / VoxCPM starts but the model is not loaded

检查：

Check:

- `VOXCPM_MODEL_PATH`
- GPU / CUDA environment
- `http://127.0.0.1:8877/healthz`

### WhisperX 返回 503 / WhisperX returns 503

通常表示服务进程在，但模型还没加载完成。

This usually means the service process is up, but the model has not finished loading yet.

先看：

Check:

- `http://127.0.0.1:7860/healthz`
- `http://127.0.0.1:7860/readyz`

### 页面打不开 / Web page does not open

先检查：

Check:

- whether port `3010` is listening
- whether `run-web.bat` is still running
- whether `web/node_modules` exists

必要时先停止再重启：

If needed, stop everything first and start again:

```powershell
cmd /c E:\VC\tts-agent-harness\stop-local-stack.bat
cmd /k E:\VC\tts-agent-harness\start-local-stack.bat
```

## 15. Bilibili Import / B 站链接导入

`素材处理` 弹窗现在支持两种来源：

- `本地文件`
- `B 站链接`

使用 `B 站链接` 时：

1. 粘贴公开视频链接
2. 选择 `下载视频` 或 `仅下载音频`
3. 点击 `解析并下载`
4. 下载完成后直接在同一弹窗里预览、裁剪并继续后续处理

Supported link shapes:

- `https://www.bilibili.com/video/BV...`
- `https://www.bilibili.com/video/av...`
- `https://b23.tv/...`

Current limitations:

- public videos only
- no login cookies
- no VIP / paid / protected content
- no batch playlists or collections

Downloaded Bilibili media is cached under:

```text
E:\VC\voice_sourse\imported\bilibili
```

The final processed clone source still goes through the normal pipeline and is written under:

```text
E:\VC\voice_sourse\imported
```

## 15. Desktop Portable Mode

If you want a lighter Windows experience without Docker, use the new desktop mode:

- [start-desktop-stack.bat](/E:/VC/tts-agent-harness/start-desktop-stack.bat)
- [start-desktop-stack-debug.bat](/E:/VC/tts-agent-harness/start-desktop-stack-debug.bat)
- [stop-desktop-stack.bat](/E:/VC/tts-agent-harness/stop-desktop-stack.bat)

Desktop mode switches the local stack to:

- `SQLite` instead of Postgres
- local filesystem storage instead of MinIO
- local in-process execution instead of depending on Prefect Server

Desktop settings live in:

- [`.desktop/desktop.env`](/E:/VC/tts-agent-harness/.desktop/desktop.env)

You can manage the paths and start/stop flow with:

```powershell
python .\desktop\launcher.py
```

If you want to build a launcher EXE:

```powershell
.\desktop\build-launcher.ps1
```

### Recommended first-run setup

For the desktop mode, the only paths most users really need to care about are:

- `VOXCPM_MODEL_PATH`
- `HF_HOME`
- `HARNESS_VOICE_SOURCE_DIR`

Recommended layout:

```text
E:\VC\
  tts-agent-harness\
  pretrained_models\
    VoxCPM2\
  hf-cache\
  voice_sourse\
```

Example values:

```text
VOXCPM_MODEL_PATH=E:\VC\pretrained_models\VoxCPM2
HF_HOME=E:\VC\hf-cache
HARNESS_VOICE_SOURCE_DIR=E:\VC\voice_sourse
```

The repo includes a desktop config template:

- `desktop/desktop.env.example`

You can either:

1. open the launcher and save the values from the UI

```powershell
python .\desktop\launcher.py
```

2. or copy the template manually

```powershell
mkdir .desktop
copy .\desktop\desktop.env.example .\.desktop\desktop.env
```

and then edit:

- `.desktop\desktop.env`

### Quick desktop checklist

If you want the lowest-friction path, do this:

1. prepare `VoxCPM2` model files
2. prepare `WhisperX / HF` cache
3. create `voice_sourse`
4. run `python .\desktop\launcher.py`
5. save the three paths
6. click `启动全部`
