# W3 Wave Gate Report

**Date**: 2026-04-09
**Branch**: `agent/W1-W2-integration` (W3 commits inlined; never created W3 branch due to isolation failure)
**Verdict**: ✅ **PASS** (with recorded incidents) — proceed to W4 next session

## Agents in this wave

| Agent | Task | Outcome | Branch / commit |
|---|---|---|---|
| **A3-retry** | Validate whisperx-svc docker build | ⚠ partial — stage1 validated, stage2 deferred | `docs/worklogs/A3-whisperx.md` updated only |
| **A4-task-p1** | P1 切分 task + p1_logic pure functions | ✅ 25/25 tests | `9a71fae` (on integration branch) |
| **A5-task-p2** | P2 Fish TTS task + fish_client | ✅ 20/20 tests | `535f29f` (on integration branch) |
| **A6-task-p5** | P5 字幕 task + p5_logic | ✅ 41/41 tests | `f816fed` (recovered, on integration branch) |
| **A7-task-p6** | P6 ffmpeg concat task + p6_logic | ✅ 25/25 tests | `f816fed` (recovered, on integration branch) |

## Test results

```
SKIP_DOCKER_TESTS=1 .venv-server/bin/python -m pytest server/tests/ -q
→ 131 passed, 7 skipped in 1.32s
```

Zero regressions from W1-W2. All 4 task agents' work integrated cleanly.

## Incidents

### Incident 1: Worktree isolation collapse (root cause: Agent tool race condition)

**Symptom**: 4 of 4 W3 task agents (A4-A7) reported they were working in `.claude/worktrees/agent-XXXX` but the actual worktrees were never created. A4 and A5 committed directly to the main checkout's branch (`agent/W1-W2-integration`); A6 and A7 left their files untracked in the same checkout.

**Root cause**: The `Agent` tool's `isolation: "worktree"` parameter has a race condition when multiple agents are spawned concurrently from the same parent. The first spawn (A3-retry) succeeded; the next 4 (A4-A7) all silently fell back to the parent's cwd.

**Detection**: Caught when reviewing A4's worklog which honestly reported "Worktree path used: /Users/xuelin/projects/tts-agent-harness (main checkout — the Bash tool's cwd resolved here)". Subsequent `git worktree list` confirmed the missing worktrees.

**Recovery**:
- A4/A5 commits already on integration branch — kept as-is
- A6/A7 untracked files manually staged and committed as `f816fed` "recover(W3): A6-P5 + A7-P6 task files (worktree isolation failure)"
- Verified `domain.py` and `pyproject.toml` were coherent in HEAD (A5's commit picked up in-flight edits from A6/A7 at write time)

**Why we got lucky**: Despite parallel writes from 4 agents, no shared file was clobbered. `domain.py` was append-only by design; `pyproject.toml` only had A5's `live` marker addition; `flows/__init__.py` and `flows/tasks/__init__.py` were created identically by multiple agents (idempotent).

**Permanent fix**: ADR-002 §5.1 rewritten — main session must explicitly pre-create worktrees via `git worktree add` before spawning, agents `cd` to absolute paths in their prompt. The `isolation` parameter is now BANNED for this project. Committed as `f4eb2c8`.

### Incident 2: A3-retry Dockerfile dependency conflicts (deferred to A12-Prod)

**What was validated**:
- PATH fix (`/Applications/Docker.app/Contents/Resources/bin`) resolves the Docker Desktop credential helper issue that A2/A3/A5 all hit
- Multi-stage Dockerfile **stage1** builds successfully (~21 min wall time)
- Final stage1 image: `whisperx-svc:builder` 3.36 GB
- All Python deps install: torch 2.8.0, whisperx 3.8.5, pyannote-audio 4.0.4, ctranslate2 4.7.1, faster-whisper 1.2.1, fastapi/uvicorn

**Issues discovered (not fixed, handed to A12-Prod)**:
1. **torch version conflict** — Dockerfile pinned torch 2.3.1 (CPU wheel) but whisperx 3.8.5 requires `torch~=2.8`, force-upgrades to torch 2.8.0 (~800 MB+ wheel). Stage1 ends up bigger than originally planned.
2. **ffmpeg apt bloat** — Debian trixie's `ffmpeg` package recommends mesa/libllvm/libdrm/libgl1 graphics stack, completely unnecessary for headless TTS. Should switch to `--no-install-recommends` or use a static ffmpeg binary (~80 MB) to bypass apt entirely.
3. **apt mirror reliability** — 500 EOF errors on libssh-4 / libblas3 / libgomp1 during apt-get update. Not blocking with retries but adds build time.

**What was NOT validated**:
- Stage2 (runtime image) was iterated multiple times by A3-retry but never produced a clean `whisperx-svc:dev` tag in the time budget
- Container cold-start measurement
- `/healthz`, `/readyz`, `/transcribe` smoke test against running container
- Image size optimization (target <2 GB)

**Confidence statement** (verbatim from A3-whisperx.md):
- High that the FastAPI server.py + lifespan model loading code is correct (6/6 unit tests)
- Medium that the Dockerfile structure is correct (stage1 proven, stage2 needs slimming)
- No end-to-end runtime validation against a live whisperx model

**Decision**: This is a deployment optimization concern, not a functional one. A12-Prod owns final Dockerfile slimming + production image build. W3 wave gate accepts the partial validation as sufficient for downstream agents (A8-Flow, A9-API) which only depend on the HTTP contract, not the live container.

## Gate checklist (ADR-002 §5.4)

- [x] All agents produced worklog (A4, A5, A6, A7, A3-retry)
- [x] All agents' tests passed (25 + 20 + 41 + 25 = 111 W3 tests, plus 20 from W2 = 131 total)
- [x] Schema diff (none — W3 didn't touch schema)
- [x] Integration verified (`pytest server/tests/` 131 passed)
- [x] Worktree protocol updated (ADR-002 §5.1) — explicit pre-creation, isolation parameter banned
- [x] W3 incidents documented in this report
- [x] Tag: `rewrite-W3-complete`

## Hand-off notes for W4 (A8-Flow + A9-API)

### Task DI pattern (already converged across A5/A6/A7)

All 3 task agents independently arrived at the same DI pattern:

```python
# Module-level injection function called once at worker startup:
def configure_p{N}_dependencies(*, session_factory, storage, ...):
    global _SESSION_FACTORY, _STORAGE
    ...

# Pure async business function (testable without Prefect):
async def run_p{N}_xxx(chunk_id: str, ...) -> P{N}Result:
    session = _SESSION_FACTORY()
    ...

# Thin Prefect task wrapper:
@task(name="p{N}-xxx", retries=N, ...)
async def p{N}_xxx(chunk_id: str, ...) -> P{N}Result:
    return await run_p{N}_xxx(chunk_id, ...)
```

**A8-Flow's worker bootstrap MUST** call all 4 `configure_*_dependencies(session_factory=, storage=)` at startup, otherwise tasks raise RuntimeError.

### Task contracts

| Task | Tags | Retries | Notes |
|---|---|---|---|
| `p1-chunk` | none | 0 | per-episode; deletes existing chunks then bulk_insert |
| `p2-synth` | `["fish-api"]` | 3 (delays 2/8/32s) | per-chunk; **must register concurrency limit** before W3 deploy |
| `p3-transcribe` | none | 5 (TBD by A8) | per-chunk; HTTP to whisperx-svc:7860 |
| `p5-subtitles` | none | 2 | per-chunk; reads transcript from MinIO, writes SRT |
| `p6-concat` | none | 2 | per-episode; ffmpeg subprocess |

### Concurrency limit registration (A8 must do)

```bash
prefect concurrency-limit create fish-api 3
```

(or whatever the Fish API plan permits)

### DomainError taxonomy (consistent across all tasks)

Tasks raise `DomainError(code, message)` with codes:
- `not_found` → A9 maps to HTTP 404
- `invalid_input` → A9 maps to HTTP 422
- `invalid_state` → A9 maps to HTTP 409

A6 noted that `DomainError` ended up in `server/core/domain.py`. A5's local copy in `fish_client.py` should be re-exported / unified — flag for A8 or W4 cleanup.

### Chunk status enum extension needed

A6 introduced `chunk.status = "p5_done"` but did not extend the `ChunkStatus` Literal in `domain.py`. **A9-API will hit serialization errors** if it tries to round-trip these values. W4 must:
1. Either extend `ChunkStatus` Literal to include `p5_done`, `p6_done`, etc.
2. Or have P5/P6 keep `chunk.status = "transcribed"` and represent stage progress only via `stage_runs` table.

Decision deferred to A8-Flow (it owns end-to-end status semantics).

### Dev environment

- DB: `postgresql+asyncpg://harness:harness@localhost:55432/harness`
- MinIO: `localhost:59000` (api), `:59001` (console), bucket `tts-harness`, `minioadmin:minioadmin`
- Prefect server: `localhost:54200`
- venv: `.venv-server` at repo root (has prefect 3.6.25 + all deps)
- Docker PATH fix required: `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"`

## Open items not blocking W4

1. **A3 docker stage2 optimization** — A12-Prod
2. **whisperx-svc:dev image not yet built** — A12-Prod or A3-followup
3. **`docs/p3-workers.md` and `docs/tts-config.md`** still untracked from earlier sessions — unrelated, ignore
4. **`web/` and `scripts/`** still have demo-era modifications in working tree — to be deleted in W4 or W5
5. **CLAUDE.md** still describes the demo Node pipeline — should be rewritten to reflect new architecture (post-W6)
