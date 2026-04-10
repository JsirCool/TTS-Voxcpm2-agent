# A8 Flow — Worklog

**Agent**: A8-Flow
**Wave**: W4
**Branch**: agent/A8-flow
**Status**: completed

## 产物

| 文件 | 说明 |
|------|------|
| `server/flows/run_episode.py` | 主 flow: P1 → P2.map → P3.map → P5.map → P6 |
| `server/flows/retry_chunk.py` | Mini flow: 单 chunk 从指定 stage 重跑, 支持 cascade/non-cascade |
| `server/flows/finalize_take.py` | Mini flow: 设置 selected take 后级联 P3 → P5 |
| `server/flows/worker_bootstrap.py` | Worker 启动时一次性注入所有 task 的 DI 依赖 |
| `server/flows/concurrency.py` | 注册 fish-api concurrency limit (默认 3) |
| `server/flows/deploy.py` | Prefect deployment 注册脚本 (3 个 deployment) |
| `server/flows/tasks/p3_transcribe.py` | P3 转写 task (完整实现, httpx → whisperx-svc) |
| `server/tests/flows/__init__.py` | 测试包 |
| `server/tests/flows/test_run_episode.py` | 端到端流程测试 (3 cases) |
| `server/tests/flows/test_retry_chunk.py` | retry mini flow 测试 (2 cases) |
| `server/tests/tasks/test_p3_task.py` | P3 task 单测 (7 cases) |
| `docs/worklogs/A8-flow.md` | 本文件 |

## 关键决策

### chunk.status 不新增值
遵循 W0 决策: chunk.status 保持 `pending → synth_done → transcribed → failed` 四值。
P5/P6 完成后 chunk.status 保持 "transcribed" 不变。P5 的 A6 实现会写 "p5_done"
(这是 A6 agent 自己的决策), 测试中兼容两者。episode.status 在 P6 完成后设为 "done"。

### P3 task DI 模式与 A5/A6/A7 一致
采用 `configure_p3_dependencies()` + module-level globals 模式,
与 P2/P5 的 DI 模式完全一致。httpx client 通过 factory 注入,测试使用 MockTransport。

### P6 task 的 DI 模式不同
P6 (A7 产出) 没有使用 module-level DI,而是在 task wrapper 中自建 session/storage。
`run_p6_concat` 接受 session + storage 参数,所以 flow 层可以直接传入。
worker_bootstrap 不需要 configure_p6。

### flow 中直接调用 run_* 函数而非 Prefect task
端到端测试绕过 Prefect runtime,直接调用 `run_p2_synth` / `run_p3_transcribe` 等纯协程。
这保证测试不需要 Prefect server,同时验证了完整的业务逻辑链。

### deploy.py 使用 `serve()` 而非 `apply()`
Prefect 3.x 推荐使用 `serve()` 来同时注册和运行 deployments。
`python -m server.flows.deploy` 启动后会注册 3 个 deployment 并进入 serve 循环。

## 放弃的方案

### 把 P3 做成纯 stub
任务要求明确 P3 task 是 A8 负责实现而不是 stub。实现了完整的 httpx → whisperx-svc 调用链。

### 在 retry flow 中包含 P6
P6 是 per-episode 操作,不适合放在 per-chunk 的 retry flow 中。
用户在所有 chunk 都完成后需要单独触发 P6(或通过 run-episode flow 的完整流程)。

## 卡点

无重大卡点。

## 给下游的提示

1. **worker_bootstrap.py 必须在 worker 启动时调用 `bootstrap()`**。否则所有 task 会 raise RuntimeError。
2. **P6 task 不走 bootstrap DI** — 它自建 session/storage。如果 A9 需要统一 DI,需要重构 P6 task。
3. **concurrency limit 注册** — `python -m server.flows.concurrency` 或 `prefect concurrency-limit create fish-api 3`。
4. **deploy.py 会启动 serve 循环** — 这是 worker + deployment 的一体化启动,适合 Docker 容器场景。

## 测试

```
SKIP_DOCKER_TESTS=1 pytest server/tests/ -v
→ 143 passed, 7 skipped in 1.29s
```

P3 task 7 cases:
- happy path (synth_done → transcribed)
- missing chunk
- chunk no selected take
- whisperx 503
- whisperx timeout
- empty transcript
- take WAV missing from storage

Flow 5 cases:
- full pipeline happy path (P1→P2→P3→P5→P6, episode done)
- P2 failure aborts
- P3 timeout aborts
- cascade=True from P2
- cascade=False marks stale
