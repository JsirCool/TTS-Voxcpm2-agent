# TTS VoxCPM2 Agent Harness

一个本地优先的 TTS 生产工作台：把脚本、文本、B 站链接、本地音视频素材，变成可审核、可重跑、可导出的配音、字幕和 Remotion 时间轴素材。

> 当前版本默认使用 **本地 VoxCPM2 + 本地 WhisperX**，面向 Windows 本地工作流，不依赖云端 TTS 或云端 ASR 服务。

## 功能亮点

| 能力 | 说明 |
|---|---|
| 本地配音 | 通过本地 `VoxCPM2` HTTP 服务完成 `声音设计 / 可控克隆 / 极致克隆` |
| 本地复核 | 通过本地 `WhisperX` 做 ASR、字幕、复核和字幕选段 |
| 素材处理 | 支持本地 `mp4 / mov / mkv / mp3 / wav / m4a`，也支持 B 站公开视频链接导入 |
| 字幕选段 | 优先使用 B 站原生字幕；没有原生字幕时，由用户确认是否启用 WhisperX 自动转写 |
| 返工工作台 | 支持按 chunk 快捷重跑、Take 历史、人工确认复核、批量处理 |
| Remotion 导出 | 导出 `shot*.wav`、`episode.wav`、`episode.srt`、`remotion-manifest.json` |

## 架构

```text
Browser
  -> Next.js Web (:3010)
  -> FastAPI API (:8100)
      -> Prefect tasks
      -> PostgreSQL + MinIO
      -> local voxcpm-svc (:8877)
      -> local whisperx-svc (:7860)
```

前端里的阶段短词对应关系：

| 阶段 | 中文标签 | 含义 |
|---|---|---|
| `P1` | `切稿` | 脚本切分 |
| `P1c` | `初检` | 初步校验 |
| `P2` | `配音` | 语音合成 |
| `P2c` | `校音` | 音频校验 |
| `P2v` | `复核` | ASR 复核 |
| `P5` | `出字` | 字幕生成 |
| `P6` | `拼轨` | 整集音频拼接 |
| `P6v` | `总检` | 最终校验 |

## Git 仓库不包含什么

这个仓库只保存源码、脚本、配置模板和文档，不会上传本地运行资产。

请不要把这些内容提交到 GitHub：

- Python 虚拟环境，例如 `E:\VC\venv312`
- Hugging Face / WhisperX 缓存，例如 `E:\VC\hf-cache`
- VoxCPM2 模型文件，例如 `E:\VC\pretrained_models\VoxCPM2`
- `voice_sourse` 下的本地参考音频
- 日志、对象存储镜像、导出缓存、`node_modules`、前端构建产物

换句话说：GitHub 上放代码，每台机器自己准备模型、缓存和参考音频。

## Windows 快速开始

先安装这些软件：

- Docker Desktop
- Python `3.12`
- Node.js `18+`
- `pnpm`
- `ffmpeg` 和 `ffprobe`

克隆仓库并创建本地 `.env`：

```powershell
git clone https://github.com/JsirCool/TTS-Voxcpm2-agent.git
cd TTS-Voxcpm2-agent
copy .env.dev .env
```

安装依赖，推荐先用一个统一的 Python 环境：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .\server[dev]
.\.venv\Scripts\python.exe -m pip install -e .\voxcpm-svc
.\.venv\Scripts\python.exe -m pip install -e .\whisperx-svc[dev]
pnpm --dir .\web install
```

然后检查这两个文件：

- `.env`
- `scripts/windows/_env.bat`

至少要确认这些值：

- `VENV_PY`
- `VOXCPM_MODEL_PATH`
- `HF_HOME`
- `VOXCPM_URL`
- `WHISPERX_URL`
- `NEXT_PUBLIC_API_URL`

如果你的机器不使用代理，请清空或删除：

- `HTTP_PROXY`
- `HTTPS_PROXY`

启动整套本地服务：

```powershell
.\start-local-stack.bat
```

启动脚本会自动启动 Docker 基础设施、执行数据库迁移、后台启动 VoxCPM / WhisperX / API / Web，并打开：

```text
http://localhost:3010
```

关闭整套本地服务：

```powershell
.\stop-local-stack.bat
```

如果你想看到服务窗口和日志，用调试启动：

```powershell
.\start-local-stack-debug.bat
```

更详细的 Windows 启动说明见 [WINDOWS-START.md](WINDOWS-START.md)。

## 本地路径约定

参考音频路径统一按相对路径保存，并从 `voice_sourse` 目录解析。

推荐目录结构：

```text
E:\VC\tts-agent-harness
E:\VC\voice_sourse
```

如果配置里写：

```json
{
  "reference_audio_path": "111.m4a"
}
```

实际会解析到：

```text
E:\VC\voice_sourse\111.m4a
```

目录名 `voice_sourse` 保持这个拼写，是为了兼容现有本地数据。

## TTS 三种模式

| 模式 | 适合场景 | 关键字段 |
|---|---|---|
| `声音设计 / Voice Design` | 不给参考音频，只靠文字描述生成音色 | `control_prompt` |
| `可控克隆 / Controllable Cloning` | 保留某个人的音色，同时可控制语气和风格 | `reference_audio_path`，可选 `control_prompt` |
| `极致克隆 / Ultimate Cloning` | 给一段前文音频和精确文本，让模型续写式复现 | `prompt_audio_path`、`prompt_text` |

合成前会做参数互斥清洗：

- `声音设计` 会清掉音频参考字段。
- `可控克隆` 会清掉 `prompt_audio_path` 和 `prompt_text`。
- `极致克隆` 会清掉 `reference_audio_path` 和 `control_prompt`。
- chunk 级覆盖参数不会串到不兼容模式里。

`极致克隆` 最重要的是音频和 `prompt_text` 精确对齐。素材处理弹窗里，`15s` 是推荐样本时长，`40s` 是硬上限。

## 新建 Episode

目前有两种方式：

1. 上传 `script.json`
2. 直接粘贴文本，由前端自动转成内部 JSON

最小脚本格式：

```json
{
  "title": "Episode Title",
  "segments": [
    { "id": 1, "type": "hook", "text": "第一段旁白。" },
    { "id": 2, "type": "content", "text": "第二段旁白。" }
  ]
}
```

`segment` 可以理解成一个镜头块或段落块。系统会再把每个 `segment` 拆成更小的合成 `chunk`。

## 素材处理：从视频或音频生成克隆素材

在前端 `TTS 配置` 旁边打开 `素材处理`。

支持输入：

- 本地文件：`mp4`、`mov`、`mkv`、`mp3`、`wav`、`m4a`
- B 站公开视频链接：`bilibili.com/video/BV...`、`bilibili.com/video/av...`、`b23.tv/...`

工作流：

1. 导入本地文件，或粘贴 B 站链接。
2. 预览视频或音频。
3. 解析字幕：
   - B 站视频优先使用原生字幕。
   - 没有原生字幕时，界面会询问是否启用 WhisperX 自动转写。
   - WhisperX 使用自动语言识别：中文就是中文，英文就是英文，不做翻译。
4. 按字幕选择连续片段，也可以手动微调开始和结束时间。
5. 给声音素材命名，例如 `小A的声音`。
6. 选择清理模式：
   - `轻量稳定 / light`：裁剪、单声道、重采样、响度规范、轻量降噪。
   - `重度人声分离 / vocal_isolate`：先用 Demucs 分离人声，再规范化。
7. 试听三段音频：
   - 原始选段
   - 处理后素材
   - 固定试配音
8. 满意后再套用到当前 Episode。

生成的声音素材会保存到：

```text
voice_sourse/assets/<voice-name>/
```

B 站源文件缓存会保存到：

```text
voice_sourse/imported/bilibili/
```

B 站导入 v1 限制：

- 只支持公开视频
- 不支持登录 Cookie
- 不支持会员 / 付费 / 受保护内容
- 不支持直播
- 不支持收藏夹、合集、批量导入

## 导出格式

导出结果同时包含按 shot 拆分的音频，以及整集拼接后的音频和字幕：

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

`remotion-manifest.json` 会包含 shot 顺序、起止时间、帧数、音频文件名和字幕 cues，方便 Remotion 直接读取。

前端也支持导出到本地目录。

## 常用地址

| 服务 | 地址 |
|---|---|
| Web | `http://localhost:3010` |
| API | `http://localhost:8100` |
| API 文档 | `http://localhost:8100/docs` |
| VoxCPM 健康检查 | `http://127.0.0.1:8877/healthz` |
| WhisperX 健康检查 | `http://127.0.0.1:7860/healthz` |
| MinIO 控制台 | `http://localhost:59001` |
| Prefect | `http://localhost:54200` |

## 常用命令

运行后端测试：

```powershell
.\.venv\Scripts\python.exe -m pytest .\server\tests -q
```

检查前端类型：

```powershell
pnpm --dir .\web exec tsc --noEmit
```

检查 API 状态：

```powershell
curl http://127.0.0.1:8100/healthz
curl http://127.0.0.1:8100/readyz
```

## 常见问题

| 现象 | 建议检查 |
|---|---|
| Web 能打开，但 Episode 加载失败 | API 可能没启动。先打开 `http://127.0.0.1:8100/healthz`。 |
| VoxCPM 合成报错 | 先检查 TTS 模式字段。`极致克隆` 需要准确的 `prompt_text`；长样本或噪声样本建议用 `可控克隆`。 |
| WhisperX 自动字幕很慢 | 正常。长视频转写会花时间，所以界面会先询问再启动 WhisperX。 |
| Docker 容器像是“不见了” | 当前 `stop-local-stack.bat` 使用 `stop`，容器应该保留为 `Exited`；如果没有，重新运行启动脚本即可。 |
| B 站导入失败 | v1 只支持公开视频，不支持私密、付费、会员、登录后可见内容。 |

## 第三方声明

本仓库包含从 `Bili23 Downloader` 派生的最小 B 站导入逻辑。

详见：

- [third_party/bili23/NOTICE.md](third_party/bili23/NOTICE.md)

由于集成了这部分来源，仓库按 GPL-3.0 兼容方式分发。

## License

GPL-3.0

## Desktop Portable Mode

This repo now also includes a Docker-free desktop mode for Windows.

What changes in desktop mode:

- database: local `SQLite`
- object storage: local filesystem directory
- orchestration: local in-process execution instead of requiring `Prefect Server`
- still required locally:
  - `VoxCPM2` model directory
  - `WhisperX / Hugging Face` cache
  - `voice_sourse` reference audio directory

Desktop mode entry points:

- `start-desktop-stack.bat`
- `start-desktop-stack-debug.bat`
- `stop-desktop-stack.bat`
- `desktop/launcher.py`

Desktop runtime data is stored under:

```text
.desktop-runtime/
  logs/
  data/
  storage/
```

Desktop settings are stored under:

```text
.desktop/desktop.env
```

Useful commands:

```powershell
python .\desktop\launcher.py
.\desktop\build-launcher.ps1
.\desktop\build-portable.ps1
```
