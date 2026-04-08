# TTS Harness MVP — 业务流程

> **本文档对应 Roadmap 中的 v0.1 MVP**(下表第一行)。
> v0.2 之后的功能不在本文档范围,详见 Roadmap 章节。

## Roadmap 总览

| 版本 | 主题 | 解决什么 | 工时 |
|---|---|---|---|
| **v0.1 MVP** ★ | **服务化** | **现有 pipeline 包成本地服务,所有交互在浏览器** | **~24h** |
| v0.2 | 稳定性与数据资产 | precheck 强化、版本化、留痕,L0→L1 底线 | ~20h |
| v0.3 | 质量评估与 review | 卡拉 OK 精准对齐、整集 review、patterns 召回 | ~25h |
| v0.4 | Agent 化 (L2 启动) | Claude API、QA agent、prompt lab | ~30h |
| v0.5 | 扩展性兑现 | 异步 job queue、Node 编排器、多 episode 并行 | ~25h |
| v1.0 | 生产化 | 远程访问、SQLite、协作集成 | ~40h |

每个版本独立有价值,中途停下不影响已有成果。

---

## v0.1 MVP

### 范围

把现有 `bash run.sh` pipeline 包成本地服务。
不改 pipeline 逻辑,不加新算法,不引入 Claude API。

### 技术栈

```
应用层      Next.js 15 (App Router) + TypeScript
脚本层      现有 JS 脚本 (零改动)
系统依赖    Python WhisperX (sidecar)、ffmpeg、Fish TTS API
```

辅助库: Tailwind、shadcn/ui (按需 copy)、SWR、zod、execa
不引入: Redux、表单库、ORM/DB、独立 backend

**Python 不可见**: WhisperX sidecar 由 `run.sh` 内部启停,Next.js 完全不知道它存在。

### 角色

只有一个: **作者**(本机单用户)。

### 业务对象

```
Episode  = 一集 = 一个 script.json + 一份产物
Shot     = 一个镜头
Chunk    = TTS 切分单元 (作者最小可操作单元 — 独立播放/编辑/重做)
```

#### Chunk 的三个文本字段

| 字段 | 用途 | 改了影响 |
|---|---|---|
| `text` | 原文(只读参考) | 一般不改 |
| `text_normalized` | TTS 朗读用 | P2 + P3 + P5 + P6 全套 |
| `subtitle_text` | 字幕显示用(可选) | 只 P5 + P6(快) |

`subtitle_text` 只在 script segment 同时定义 `tts_text` 和 `text` 且不同时由 P1 生成。
典型: TTS 读"七万美元",字幕显示"70000 美元"。

### Episode 状态

```
empty → ready → running → done
                   │
                   └─→ failed → (Retry) → running

done → (改 chunk + Apply) → running → done
done → (Export) → 拷到 Remotion
```

状态从文件系统推断(无 DB 字段)。

### Chunk 级状态(前端 only)

```
normal ─▶ playing  ─┐
         editing  ──┤── (Stage Change) ──▶ dirty (★ 播放禁用)
                                            │
                                            ├─ Apply All ─▶ 重做
                                            └─ Discard  ─▶ normal
```

**Dirty 双类型**(决定走哪条 pipeline):
- `tts dirty` — 改了 `text_normalized` → P2 + P3 + P5 + P6
- `subtitle dirty` — 改了 `subtitle_text` → 只 P5 + P6

### UI 主流程

```
打开浏览器 (localhost:3000)
    │
    ▼
Episode 列表 (sidebar)
    │
    ├─ [+ 新建] → 上传 script.json → ready
    │
    ▼
Episode 详情面板
    ├─ 顶部: status + Run / Export
    ├─ 中间: Chunks 表 (核心交互区)
    └─ 底部: run.log tail
    │
    ├─[Run]    ─▶ pipeline 全跑
    ├─[行内 ▶] ─▶ 单 chunk 试听 + 卡拉 OK 字幕
    └─[行内 ✎] ─▶ 编辑面板(3 字段) ─▶ Stage Change ─▶ dirty
                                            │
        ┌───────────────────────────────────┘
        ▼
    顶部 banner: "N TTS 改动 | M 字幕改动" [Apply All] [Discard]
        │
        ├─[Apply All] ─▶ 后端批量重做(P2 并发 + P3 串行 + P5/P6 一次)
        │
        └─ done → 试听满意 → [Export] → 拷到 Remotion
```

### 浏览器动作清单

| # | 作者动作 | 后端 |
|---|---|---|
| 1 | 打开 web | Next.js 渲染主页 |
| 2 | 切换 episode | GET `/api/episodes/[id]` |
| 3 | 新建 episode | POST `/api/episodes` (multipart) |
| 4 | 跑 pipeline | POST `/api/episodes/[id]/run` → spawn run.sh |
| 5 | 看进度 | SWR 2s 轮询 |
| 6 | 试听 chunk | GET `/api/audio/[id]/[file]` + 卡拉 OK |
| 7 | 编辑 chunk | (前端 only) 展开 3 字段编辑面板 |
| 8 | 暂存改动 | (前端 only) banner 计数 +1 |
| 9 | 批量重做 | POST `/api/episodes/[id]/apply` body: edits |
| 10 | retry × N | POST `/api/episodes/[id]/chunks/[cid]/retry?count=N` (multi-take) |
| 11 | 导出 | POST `/api/episodes/[id]/export` |

### 不变量

1. 一次只跑一个 job(全局 lock,第二个请求 409)
2. 作者全程不碰终端
3. pipeline 脚本零改动
4. 文件系统是真源(无 DB)
5. 失败可见但不自动恢复
6. Python 不可见(adapter 隔离)
7. **Chunk 是最小可操作单元** — 试听/编辑/重做都是 chunk 级
8. **dirty 期间禁用播放** — 防止听到旧版本
9. **批量重做单次执行** — 多个 dirty 一次过 P2/P3/P5/P6
10. **编辑期间原 chunk 行可见** — 编辑面板独立行展开

### 不在 v0.1 范围

- 多用户/鉴权、远程访问
- 多 episode 并行(P3 sidecar 单例)
- 真实时 SSE(用 SWR 轮询)
- 数据库
- precheck 强化、patterns 库、Claude API → **v0.2/v0.4**
- 整集播放器、review 队列 → **v0.3**

---

## 架构边界

底层脚本会重构,为隔离影响,Next.js 内部分四层:

```
1. Frontend (React)              — 只知道 HTTP API
2. Route Handlers (app/api/...)  — 只调 lib/factory.getServices()
3. Domain Layer (lib/ports/*)    — 接口定义,无实现
4. Adapter Layer (lib/adapters/) — 知道脚本路径、命令行、chunks.json schema
```

**强制规则**:
- chunks.json 不暴露到前端(zod 在 adapter 转换)
- 命令行/路径只在 adapter
- stage 是 opaque string(前端不枚举)
- chunks.json 字段只增不删(`z.passthrough()`)
- lock 三 scope: global / episode / chunk

### Domain 接口清单(`lib/ports/*.ts`)

```
EpisodeStore       list / get / create / delete
ChunkStore         get / applyEdits / appendTake / selectTake / removeTake
PipelineRunner     runFull / applyEdits / retryChunk / finalizeTake / cancel / getJobStatus
LockManager        acquire / isBusy / list  (LockScope: global|episode|chunk)
ProgressSource     getCurrentStage / isRunning
LogTailer          tail / clear
AudioService       getTakeFile / getShotFile
PreviewService     getPreviewFile
ExportService      exportTo
```

唯一拼装的地方: `lib/factory.ts` 的 `getServices()`,切换 adapter 只改这里。

### 关键扩展点

| 未来重构 | 改哪里 | 上层破坏? |
|---|---|---|
| TS 重写 P1/P2 | `legacy/runner.ts` | 否 |
| 替换 Fish TTS / WhisperX | `legacy/*` | 否 |
| 加 P0/P3.5 stage | `legacy/runner.ts` | 否 |
| chunks.json 加字段 | `legacy/chunks-schema.ts` | 否 |
| Multi-take 实现 | 接口已有 | 否 |
| bash → Node 编排器 | 新增 `adapters/node-orchestrator/` | 否 |
| sqlite 替代文件 | 新增 `adapters/sqlite/` | 否 |
| events.jsonl 替代 stdout | 新增 ProgressSource impl | 否 |
| 异步 job queue | 接口已返回 OperationResult | 否 |
| chunk 级并发 | LockScope.chunk 已支持 | 否 |
| 加 patterns 库 | 新接口 PatternStore,正交 | 否 |

---

## 项目结构

```
tts-agent-harness/                  ← 项目根
├── scripts/  run.sh  .work/  episodes/   ← 现有,不动
├── prototype.html                  ← UI 原型
├── mvp-flow.md                     ← 本文档
├── business-design.md              ← L1 路线
│
└── web/                            ← 新增 Next.js 应用
    ├── app/
    │   ├── page.tsx                ← 单页主入口
    │   └── api/
    │       ├── episodes/           [GET list / POST create]
    │       │   └── [id]/
    │       │       ├── route.ts                      [GET detail]
    │       │       ├── run/route.ts                  [POST run]
    │       │       ├── apply/route.ts                [POST batch redo]
    │       │       ├── export/route.ts               [POST export]
    │       │       └── chunks/[cid]/retry/route.ts   [POST retry × N]
    │       ├── audio/[id]/[cid]/[takeId]/route.ts    [静态音频]
    │       └── preview/[id]/route.ts                 [转发现有 preview.html]
    │
    ├── components/  (EpisodeSidebar / ChunksTable / ChunkRow /
    │                 ChunkEditor / KaraokeSubtitle / TakeSelector /
    │                 EditBanner / LogViewer / NewEpisodeDialog)
    │
    └── lib/
        ├── types.ts                ← Domain types
        ├── factory.ts              ← ★ 唯一拼装 adapter 的地方
        ├── ports/                  ← 接口定义 (store/runner/lock/observability/files)
        └── adapters/legacy/        ← MVP 唯一实现
```

---

## 实施计划

| Phase | 内容 | 工时 |
|---|---|---|
| 0 | Next.js 项目初始化 | 0.5h |
| 1 | Domain 接口 + Legacy adapter + Route(基础) | 5.5h |
| 2 | 静态资源 + 上传 + 导出 | 1.5h |
| 3 | 前端骨架 + 只读视图 | 4h |
| 4 | 单 chunk 播放 + 卡拉 OK | 3h |
| 5 | 编辑 + 暂存 + Apply | 4h |
| 5.5 | Multi-take 重试 | 4h |
| 6 | 收尾(失败处理 / 409 / 冒烟测试) | 2h |
| **合计** | | **24.5h ≈ 3 工作日** |

### 关键判断

- **接口先行**: `lib/ports/*` 写完再写 adapter,接口不对回头改接口
- **后端先行**: Phase 1-2 全部跑通(curl 验证)再开始前端
- **渐进交付**: 只读 → 播放 → 编辑 → multi-take,每个 phase 独立可验收
- **不写测试**: MVP 阶段跑通即验收,契约测试留 v0.2

### 风险

| 风险 | 缓解 |
|---|---|
| 卡拉 OK 字符按时间均分,字符宽度不均 | MVP 接受误差,v0.3 用 word-level 时间戳 |
| Next.js dev 模式 fast refresh 杀子进程 | `process.on('exit')` 注册清理 |
| Apply 期间作者继续编辑其他 chunk | 允许 — local state,下次 Apply 才生效 |

### 启动方式

```bash
cd web && npm install && npm run dev
```

浏览器打开 `http://localhost:3000`。
