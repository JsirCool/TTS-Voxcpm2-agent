# TTS Agent Harness 业务设计文档(L1)

> **文档定位**: 这是 L1 阶段的业务契约,描述"作者 + harness"如何协作完成一集 TTS 生产。
> 它不描述具体脚本怎么写、不描述 JSON schema,只描述**业务单位、状态、流程、决策点和介入契约**。
> 任何技术实现(脚本、frontend、Claude API)都必须先满足本文档的契约,而不是反过来。

---

## 0. 元原则

本设计严格遵守 5 条不可违反原则:

1. **评估先于修复** — 没有量化评估函数的阶段不自动化
2. **幂等 + 可回滚** — 同输入同输出,任何修改可 revert
3. **状态机显式化** — 用 status 字段表达所有转换,不靠文件存在与否推断
4. **人工介入显式化** — 人工是一等公民流程,不是 Agent 失败的兜底
5. **收敛性保证** — 每个循环必须有终止条件 + 监控 + 死循环检测

任何流程改动必须能对照这 5 条说清楚遵守了哪几条、违反了没有。

---

## 1. 业务定义

### 1.1 业务单位

```
Project       一个内容项目(整季/整套)
  └─ Episode  一集脚本 = 一个 script.json = 一次完整生产
      └─ Shot 一个镜头/段落 (作者关心的最小单位)
          └─ Chunk  TTS 切分单元 (技术单位,作者不直接操作)
```

**关键约定**:
- **作者只对 Shot 负责**,Chunk 是 harness 内部细节
- **Shot 是最小局部重做单元**(不能只重做半个 shot)
- **Episode 是状态机的载体**(整集级别的进度可见)

### 1.2 业务角色

```
作者(你)        决定脚本内容、做最终验收、处理介入窗口
harness         自动执行 P1-P6,执行 precheck,记录 patterns
patterns 库     L1 阶段的核心产出,沉淀作者每次介入的决策
```

L1 阶段**只有这三个角色**。Claude API、Agent、Frontend 都不在 L1 范围内。

### 1.3 核心数据资产

按重要性排序:

| 资产 | 含义 | 存储 | 一等公民? |
|---|---|---|---|
| **patterns 库** | 每次人工修复的结构化记录 | `.harness/fixes/<ep>/*.json` | ★ L1 最重要产出 |
| **chunks.json** | 当前 episode 的状态机 + 文本 | `.work/<ep>/chunks.json` | ★ 单一真源 |
| **chunks.json 历史快照** | atomic replace 前的版本 | `.work/<ep>/chunks.json.v<ts>` | ★ 回滚依据 |
| 音频/转写产物 | wav + transcript json | `.work/<ep>/audio/`、`transcripts/` | 可重建,非真源 |
| trace.jsonl | 阶段耗时与事件 | `.work/<ep>/trace.jsonl` | 调试用 |

**核心论点**: L1 阶段的成功不靠音质提升,**靠 patterns 库积累的数据**。没有数据,L2 永远做不出来。

---

## 2. 业务状态机

### 2.1 Episode 级状态

```
                    [收稿]
                       │
                       ▼
                  ┌─────────┐
                  │  draft  │  原始 script.json,未进 harness
                  └────┬────┘
                       │ harness 启动
                       ▼
                  ┌─────────┐
                  │ chunked │  P1 完成,chunks.json 已生成
                  └────┬────┘
                       │
                       ▼
                  ┌──────────────┐
                  │ synthesizing │  P2/P3 在跑或部分完成
                  └──────┬───────┘
                         │ 全部 chunk synth_done + transcribed + check3
                         ▼
                  ┌─────────────┐
                  │  qa_pending │  precheck 通过,等人工试听
                  └─────┬───────┘
                        │
              ┌─────────┴──────────┐
              │                    │
        [全部接受]            [发现可疑 chunk]
              │                    │
              │                    ▼
              │             ┌──────────────┐
              │             │ intervention │ 进入"安全介入窗口"
              │             └──────┬───────┘
              │                    │
              │              [改 + 重跑 +
              │               写 patterns]
              │                    │
              │                    ▼
              │             回到 synthesizing
              │
              ▼
         ┌─────────┐
         │reviewed │  全部 chunk 被作者确认
         └────┬────┘
              │ 自动跑 P5/P6/checkp6
              ▼
         ┌─────────┐
         │produced │  有完整 wav + 字幕产物
         └────┬────┘
              │ 整集试听
              ▼
        ┌─────┴──────┐
        │            │
   [整集 OK]    [局部重做]
        │            │
        │            ▼
        │     标记需重做的 shot
        │     → 回 chunked (只 reset 这些 shot 的 chunks)
        │
        ▼
   ┌──────────┐
   │delivered │  --output-dir 拷贝到下游项目
   └──────────┘
```

### 2.2 Chunk 级状态

```
          ┌──────────────────────┐
          │      pending         │ ← P1 产出 / 介入后 reset
          └──────────┬───────────┘
                     │ P2
                     ▼
          ┌──────────────────────┐
          │     synth_done       │
          └──────────┬───────────┘
                     │ check2
            ┌────────┴────────┐
            │                 │
         pass                fail
            │                 │
            ▼                 ▼
                       ┌──────────┐
                       │  flagged │ ← 进介入窗口
                       └──────────┘
            │
            ▼ P3
          ┌──────────────────────┐
          │     transcribed      │
          └──────────┬───────────┘
                     │ check3 (强化版)
            ┌────────┴────────┬────────────┐
            │                 │            │
         pass              suspect        fail
            │                 │            │
            ▼                 ▼            ▼
   ┌──────────────┐   ┌──────────┐  ┌──────────┐
   │ qa_approved  │   │ flagged  │  │ flagged  │
   └──────────────┘   └──────────┘  └──────────┘
            │                 │            │
            │ (作者最终确认)   ▼            ▼
            ▼            介入窗口     介入窗口
   ┌──────────────┐
   │  confirmed   │ ← P5/P6 消费这个状态
   └──────────────┘
```

**关键改动 vs 现状**:
- **新增 `flagged` 状态**: precheck 不通过的 chunk 不再静默 warning,而是显式进入 flagged → 阻塞下游
- **新增 `suspect` 等级**: check3 输出 confidence,不是 binary
- **新增 `confirmed` 状态**: 作者主动确认才能进 P5(L1 仍可一键全部确认)
- **删除隐式 `synth_failed`/`transcribe_failed`**: 全部归到 flagged + 错误原因字段

### 2.3 状态转移不变量

```
不变量 1: 单调推进
  pending → synth_done → transcribed → qa_approved → confirmed
  正常情况下只能往后走

不变量 2: flagged 可逆
  任何状态都可以 → flagged
  flagged 只能由"介入窗口"流程退出 → pending

不变量 3: 边界变更立即失效
  chunk_boundary_hash 改变 → 该 chunk + 后继 chunk 全部 reset 到 pending
  (P1 --text-only 模式下不会触发)

不变量 4: 介入即留痕
  任何 status 改变 + text_normalized 改变 → 必须写 patterns 库
  不能"偷偷改 JSON 不留记录"

不变量 5: 全部 confirmed 才能进 P5
  P5/P6 只读 confirmed 状态的 chunk
  存在任何 flagged → P5 拒绝运行
```

---

## 3. 业务流程图(L1 主流程)

```
┌──────────────────────────────────────────────────────────────────┐
│ Step 1: 收稿                                                      │
│                                                                   │
│   作者准备 script.json (原始脚本)                                 │
│   决策: 是否需要文案 TTS 化?                                      │
│     → L1 阶段: 作者自己负责优化 (插停顿/标读法)                   │
│     → L2 阶段才考虑用 Claude API 自动化                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│ Step 2: 启动 harness                                              │
│                                                                   │
│   bash run.sh script.json <episode>                              │
│                                                                   │
│   ★ 不变量: hash mismatch 时 abort + 提示用 --force               │
│   ★ 不变量: --from pN 优先于 hash 检测                            │
│                                                                   │
│   harness 自动执行: P1 → P2 → check2 → P3 → check3                │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│ Step 3: 自动评估 (强化 check3)                                    │
│                                                                   │
│   每个 chunk 经过三层评估:                                         │
│                                                                   │
│   ┌─ 评估 1: ratio gate                                           │
│   │  转写字符数 / 原文字符数 ∈ [0.85, 1.15]                       │
│   │  超出 → flagged                                               │
│   │                                                               │
│   ├─ 评估 2: 关键词 alignment                                     │
│   │  从 text 提取英文 token + 数字 token                          │
│   │  检查 WhisperX word-level 是否包含                            │
│   │  检查时长合理性 (单字 < 1s, 缩写每字母 < 0.5s)                │
│   │  缺失任何关键词 → flagged                                     │
│   │                                                               │
│   └─ 评估 3: 韵律检查                                             │
│      chars/sec 与 shot 内其他 chunk 平均值偏离 > 30%              │
│      → flagged (warning 级)                                       │
│                                                                   │
│   每个 chunk 输出 confidence score (0-1)                          │
│                                                                   │
│   ★ 这是"评估先于修复"原则的核心实现                              │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼
                         所有 chunk 通过?
                                 │
                  ┌──────────────┴──────────────┐
                  │ 是                          │ 否
                  ▼                             ▼
       ┌──────────────────┐         ┌─────────────────────────┐
       │ Step 4: 一键确认 │         │ Step 5: 介入窗口        │
       │                  │         │   (见下方详细流程)       │
       │ 作者一键全部     │         └─────────┬───────────────┘
       │ confirmed        │                   │
       └────────┬─────────┘                   │
                │                             │
                │           ┌─────────────────┘
                │           │
                ▼           ▼
       ┌──────────────────────────────┐
       │ Step 6: 自动后处理            │
       │   P5 → P6 → checkp6          │
       └──────────────┬───────────────┘
                      │
                      ▼
       ┌──────────────────────────────┐
       │ Step 7: 整集试听              │
       │                              │
       │ 作者打开 V2 preview          │
       │ 听完后决策:                  │
       │   → 通过      → Step 8       │
       │   → 局部重做  → 标记 shot   │
       │     → 回 Step 5 (改文案)     │
       └──────────────┬───────────────┘
                      │
                      ▼
       ┌──────────────────────────────┐
       │ Step 8: 交付                  │
       │   --output-dir 拷贝到下游     │
       └──────────────────────────────┘
```

---

## 4. 介入窗口流程(L1 核心)

这是 L1 区别于 L0 的最关键部分。L0 的"手动介入"是 ssh 改 JSON,L1 的介入是**结构化操作 + 自动留痕**。

### 4.1 介入入口

任何时候,只要存在 `flagged` chunk,作者就可以进入介入窗口:

```bash
node scripts/intervention.js --episode <ep>
# 或
node scripts/intervention.js --episode <ep> --chunk <chunk_id>
```

### 4.2 介入流程图

```
              [介入窗口入口]
                    │
                    ▼
        ┌──────────────────────────┐
        │ 列出所有 flagged chunk    │
        │ 按 confidence 升序排序    │
        │ (最可疑的优先)            │
        └────────────┬─────────────┘
                     │
                     ▼
              对每个 flagged chunk:
                     │
                     ▼
        ┌──────────────────────────┐
        │ 展示信息:                 │
        │ 1. 试听 wav (open 命令)   │
        │ 2. 原文 + 转写 + diff     │
        │ 3. confidence 原因        │
        │    (哪些评估不通过)       │
        │ 4. 历史相似 patterns      │
        │    (从 patterns 库召回)   │
        └────────────┬─────────────┘
                     │
                     ▼
                作者四选一:
                     │
   ┌──────────┬──────┴──────┬──────────────┐
   │          │             │              │
   ▼          ▼             ▼              ▼
┌──────┐ ┌────────┐  ┌──────────┐  ┌──────────┐
│accept│ │ revise │  │  skip    │  │ rollback │
│原样  │ │改文本   │  │标记瑕疵  │  │回滚到    │
│接受  │ │重跑 P2 │  │允许通过  │  │上个版本  │
└──┬───┘ └───┬────┘  └────┬─────┘  └────┬─────┘
   │         │            │             │
   │         ▼            │             │
   │   ┌──────────┐       │             │
   │   │强制留痕: │       │             │
   │   │写 patterns│       │             │
   │   │chunks 快照│       │             │
   │   └─────┬────┘       │             │
   │         │            │             │
   │         ▼            │             │
   │   ┌──────────┐       │             │
   │   │status =  │       │             │
   │   │ pending  │       │             │
   │   └─────┬────┘       │             │
   │         │            │             │
   │         ▼            │             │
   │   ┌──────────┐       │             │
   │   │run.sh    │       │             │
   │   │--from p2 │       │             │
   │   │--chunk X │       │             │
   │   └─────┬────┘       │             │
   │         │            │             │
   │         ▼            │             │
   │   重新进入 check3    │             │
   │         │            │             │
   │         ▼            │             │
   │   仍然 flagged?      │             │
   │         │            │             │
   │      ┌──┴──┐         │             │
   │      │     │         │             │
   │      ▼     ▼         │             │
   │   通过  仍然失败     │             │
   │      │     │         │             │
   │      │     └──→ 回到决策 (max 3 轮) │
   │      │                              │
   │      └──────────┐                  │
   │                 │                  │
   ▼                 ▼                  ▼
┌────────────────────────────────────────────┐
│ status = qa_approved                       │
│ chunks.json atomic replace + 快照          │
│ 写入 .harness/fixes/<ep>/<chunk>-<ts>.json │
└──────────────────┬─────────────────────────┘
                   │
                   ▼
              下一个 flagged chunk
                   │
                   ▼
          全部处理完 → 返回 Step 6
```

### 4.3 四个决策的语义

| 决策 | 含义 | 状态变化 | 是否写 patterns |
|---|---|---|---|
| **accept** | 评估说有问题,但作者听了觉得没事(误报) | flagged → qa_approved | 是,标记 `verdict=false_positive` |
| **revise** | 真有问题,改文案重跑 | flagged → pending → ... | 是,标记修改前后 |
| **skip** | 知道有瑕疵但接受(如咬字不清但无关键词) | flagged → qa_approved | 是,标记 `verdict=accepted_defect` |
| **rollback** | 这次改坏了,回到上个 chunks.json 版本 | 回到上版本的状态 | 是,标记 `verdict=rollback` |

**关键**: 四种决策都必须留痕,**不允许"接受了但不记原因"**。这是 L1 数据资产积累的硬约束。

### 4.4 收敛性保证

```
单 chunk revise 循环:
  最多 3 轮 → 仍然 flagged → 强制要求作者 accept 或 skip
  这确保不会出现"改了 N 次都改不好但 harness 不告警"的情况
```

---

## 5. patterns 库设计

### 5.1 文件结构

```
.harness/fixes/
  └── <episode>/
       ├── <chunk_id>-<ts>.json    # 每次介入一个文件
       └── <chunk_id>-<ts>.json
```

### 5.2 单条 patch 字段

```json
{
  "schema_version": 1,
  "episode": "ch04",
  "chunk_id": "shot02_chunk01",
  "ts": "2026-04-08T10:30:00Z",

  "verdict": "revise" | "accept" | "skip" | "rollback" | "false_positive" | "accepted_defect",

  "problem_type": "english_word_misread" | "number_misread" | "duration_anomaly" | ...,
  "problem_evidence": {
    "ratio": 0.65,
    "missing_keywords": ["BTC"],
    "chars_per_sec": 9.2
  },

  "text_before": "...",
  "text_after": "...",

  "transcript_before": "...",
  "transcript_after": "...",

  "reason": "BTC 被读成'比特',改成 B T C",
  "reason_source": "manual" | "pattern_suggested",

  "succeeded": true,
  "rounds_taken": 1
}
```

### 5.3 patterns 库的用途(按阶段)

| 阶段 | 用途 |
|---|---|
| **L1** | 介入窗口展示历史相似 patches,帮作者快速决策 |
| **L1 → L2 进入条件** | 累计 ≥ 30 条同类 patches 才能进 L2 |
| **L2** | Fix Proposer Agent 基于 patches 做候选生成 |
| **L3** | 按 problem_type 计算自动 fix 成功率,作为信任阈值依据 |

**L1 阶段不写任何 Agent 来用 patterns,patterns 只用于人工查阅**。

### 5.4 problem_type 枚举(初始集)

```
english_word_misread     英文单词读错 (如 BTC → 比特)
number_misread           数字读错
duration_anomaly         语速异常
char_ratio_low           转写漏字
char_ratio_high          转写多字
control_marker_ignored   [break] 等控制标记未生效
prosody_off              韵律偏离 shot 平均
unclear                  暂不分类 (作者填)
```

枚举允许扩展。每次介入如果发现新类型,作者填 `unclear` + reason,后续 review 时合并。

---

## 6. 安全介入窗口契约

这一节定义"什么 status 下允许做什么操作 + 操作后必须跑什么"。

### 6.1 允许的人工操作矩阵

| 当前 status | 允许操作 | 禁止操作 | 操作后必须 |
|---|---|---|---|
| `pending` | 改 text_normalized (经 edit-chunk.js) | 直接编辑 chunks.json | 重跑 P2 |
| `synth_done` | 听 wav,标记 flagged | 改 text_normalized | — |
| `transcribed` | 看转写,标记 flagged/qa_approved | 改 text_normalized | — |
| `qa_approved` | 改回 flagged | 改 text_normalized | — |
| `flagged` | 介入窗口的四种决策 | 直接 set qa_approved 跳过 | 见 4.2 流程 |
| `confirmed` | rollback 到 qa_approved | 改任何字段 | — |

### 6.2 三个绝对禁令

1. **禁止用任何文本编辑器直接改 `.work/<ep>/chunks.json`**
   - 必须经 `scripts/edit-chunk.js` 或 `scripts/intervention.js`
   - 这两个工具会自动做 atomic replace + 快照 + 写 patterns

2. **禁止跨过 flagged 状态运行 P5/P6**
   - P5 启动时检查: 存在 flagged → abort

3. **禁止删除 `.harness/fixes/`**
   - 这是 L1 的核心数据资产
   - 即使是错误的 patch 也不能删,只能加新的 verdict 覆盖

### 6.3 工具清单

L1 阶段必须存在的工具(对应 5 条原则):

| 工具 | 对应原则 | 职责 |
|---|---|---|
| `scripts/edit-chunk.js` | #2 #3 #4 | 唯一允许的 chunks.json 修改入口 |
| `scripts/intervention.js` | #4 | 介入窗口主循环 |
| `scripts/chunks-revert.js` | #2 | 回滚到指定快照 |
| 强化的 `scripts/precheck.js` | #1 | 三层评估 + confidence |
| `scripts/check-status.js` | #3 | 检查全集 chunk 状态 + 不变量校验 |

---

## 7. L0 → L1 交付物清单

按文档原计划,具体动作:

| # | 交付物 | 工时 | 对应原则 |
|---|---|---|---|
| 1 | 强化 precheck (ratio gate + 关键词 alignment + 韵律检查) | 半天 | #1 |
| 2 | chunks.json 版本化 + atomic replace + chunks-revert.js | 半天 | #2 #3 |
| 3 | P1 `--text-only` 模式 | 1 小时 | #2 |
| 4 | script hash 检测改 abort + `--from` 优先 | 0.5 小时 | #3 |
| 5 | edit-chunk.js + patterns 库 logging | 1 天 | #4 |
| 6 | 安全介入窗口 SOP 写入 CLAUDE.md | 半天 | #4 |

合计约 **3 天**。L1 完成的判定:这 6 项全部 ✓ + 跑通一集 episode 全流程 + 至少积累 5 条 patches。

---

## 8. L2/L3 触发条件(防止过早升级)

为避免重蹈 P4 覆辙,L2/L3 的进入有硬条件:

### L1 → L2 进入条件

```
✓ L1 6 个交付物全部完成
✓ patterns 库累计 ≥ 30 条
✓ 至少 3 个 problem_type 各有 ≥ 5 条 patches
✓ 能基于 patterns 算出每类问题的"重做后成功率"
✓ 作者使用 intervention.js 跑过 ≥ 5 个 episode
```

不达成全部 5 条不进 L2。**这是不可妥协的硬约束。**

### L2 引入的新角色

仅在进入 L2 后才允许引入:

- **QA Agent**: 输入 patterns + chunks + transcripts,输出"问题清单"(不执行修复)
- **Fix Proposer Agent**: 基于 patterns 生成候选修复(2-3 个,按历史成功率排序)
- **QA UI**: 把 intervention.js 的 CLI 体验升级为 Web

L2 阶段的 Agent **绝不自动执行修复**,只提议。作者点"应用"才执行。

### L2 → L3 进入条件

```
✓ L2 运行 ≥ 1 个月
✓ 某 problem_type 的 fix 成功率 ≥ 95% (才允许该类自动化)
✓ 80-95% 的类型走"自动提议 + 一键确认"
✓ < 80% 的类型仍走人工
✓ 完全未知类型立即升级告警
```

L3 不是"全自动",是**按问题类型分级释放信任**。

---

## 9. 与现状的差异速查

| 维度 | L0 现状 | L1 目标 | 差异 |
|---|---|---|---|
| 评估 | precheck 只 warning | precheck 起 gate + confidence | 评估必须能阻塞流程 |
| chunks.json | 直接覆盖 | atomic replace + 快照 | 可回滚 |
| 边界变更 | text_normalized 相等假设 | chunk_boundary_hash | 显式失效 |
| 人工介入 | ssh 改 JSON | edit-chunk.js + patterns 留痕 | 数据可积累 |
| status 字段 | pending/synth_done/transcribed | + flagged/confirmed | 显式 gate |
| 收敛保证 | 无 | 单 chunk revise ≤ 3 轮 | 防死循环 |
| script_hash | 静默回 P1 | mismatch abort | 可预测 |
| Claude API | 无 | 仍然无 | L1 不引入 |
| 前端 | 无 | 仍然无 | L1 不引入 |

---

## 10. 反 anti-pattern 清单

L1 阶段**绝对不做**的事(即使看起来诱人):

1. ❌ 引入 Claude API 节点(P0/P3.5/P5.5)
2. ❌ 加 LLM 自动 fix 循环
3. ❌ 加前端
4. ❌ 加多 episode 并行调度
5. ❌ 加 DAG 编排框架(Dagster/Prefect/Inngest 等)
6. ❌ 加 Agent 框架(LangGraph/Mastra/CrewAI 等)
7. ❌ 重写技术栈(JS → Python 或反过来)
8. ❌ 把 chunks.json 迁数据库
9. ❌ 在 patterns 库还没数据时设计 Agent 架构

每出现一次想做这些事的冲动,回看第 0 节 5 条原则,大概率违反第 1 条。

---

## 11. 一句话总结

> 这个系统从"确定性脚本 + 手动 QA"演进到"全自动 Agent",中间必须经过"手动 QA 被结构化记录"这个阶段。
>
> **数据比架构重要,评估比修复先行,幂等比智能先行。**
