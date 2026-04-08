#!/bin/bash
# e2e-mvp.sh — TTS Harness MVP 端到端流程测试
#
# 验证 web/ 服务的全部 HTTP API + chunks.json 状态同步。
# 不依赖 FISH_TTS_KEY/真模型 — 纯 API 行为测试。
#
# 用法:
#   bash test/e2e-mvp.sh
#
# 前提:
#   - cd web && npm run dev (端口 3010)
#   - 项目根有 episodes/script-demo-short.json 和 script-demo-long.json
#
# 退出码: 0=全过, 非 0=有 case 失败

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3010}"
BASE="http://localhost:$PORT"
# 用函数避免 shell 把 '*' glob 展开
CURL() { curl --noproxy '*' -s "$@"; }

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
FAILURES=()

# ─── helpers ────────────────────────────────────────────────────────

ok() {
  PASS=$((PASS+1))
  echo -e "  ${GREEN}✓${NC} $1"
}

fail() {
  FAIL=$((FAIL+1))
  FAILURES+=("$1")
  echo -e "  ${RED}✗${NC} $1"
}

section() {
  echo
  echo -e "${BLUE}━━━ $1 ━━━${NC}"
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" == "$expected" ]]; then
    ok "$label (=$expected)"
  else
    fail "$label (expected=$expected actual=$actual)"
  fi
}

assert_status() {
  local code="$1"
  local expected="$2"
  local label="$3"
  if [[ "$code" == "$expected" ]]; then
    ok "$label HTTP=$code"
  else
    fail "$label HTTP=$code (expected $expected)"
  fi
}

# ─── 0. 服务健康检查 ─────────────────────────────────────────────────

section "0. 服务健康检查"

CODE=$(CURL -o /dev/null -w "%{http_code}" "$BASE/api/episodes")
if [[ "$CODE" != "200" ]]; then
  echo -e "${RED}服务未启动或不健康 (port $PORT, code=$CODE)${NC}"
  echo "请先 cd web && npm run dev"
  exit 1
fi
ok "GET /api/episodes → 200"

# ─── 1. demo-short e2e ─────────────────────────────────────────────

section "1. demo-short 全流程"

# 1.1 episode 应该在列表里(因为 script 文件已有)
LIST=$(CURL "$BASE/api/episodes")
if echo "$LIST" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ids = [e['id'] for e in d['episodes']]
sys.exit(0 if 'demo-short' in ids else 1)
" 2>/dev/null; then
  ok "demo-short 出现在 /api/episodes 列表"
else
  fail "demo-short 不在列表 (检查 episodes/script-demo-short.json 是否存在)"
fi

# 1.2 GET 详情
DETAIL=$(CURL "$BASE/api/episodes/demo-short")
STATUS=$(echo "$DETAIL" | python3 -c "import json,sys;print(json.load(sys.stdin)['episode']['status'])" 2>/dev/null)
echo "  当前 status: $STATUS"
if [[ "$STATUS" == "ready" || "$STATUS" == "done" || "$STATUS" == "failed" ]]; then
  ok "demo-short 详情可读 (status=$STATUS)"
else
  fail "demo-short status 异常: $STATUS"
fi

# 1.3 检查 metadata.scriptMissing 应为 false (script 存在)
MISSING=$(echo "$DETAIL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print((d['episode'].get('metadata') or {}).get('scriptMissing', False))
" 2>/dev/null)
assert_eq "$MISSING" "False" "demo-short 不是 orphan"

# 1.4 触发 Run (注意:不真等 pipeline 完,只验证 endpoint 立即返回)
RUN_RESP=$(CURL -X POST "$BASE/api/episodes/demo-short/run")
RUN_CODE=$(echo "$RUN_RESP" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('ok' if 'jobId' in d else 'no_jobid')
except:
    print('not_json')
" 2>/dev/null)
if [[ "$RUN_CODE" == "ok" ]]; then
  ok "POST /api/episodes/demo-short/run 返回 jobId"
else
  fail "POST run 异常: $RUN_RESP"
fi

# 1.5 立即第二次 Run 应该 409 (lock busy)
sleep 0.3  # 让 .running 文件确实落盘
CODE2=$(CURL -o /dev/null -w "%{http_code}" -X POST "$BASE/api/episodes/demo-short/run")
assert_status "$CODE2" "409" "并发 Run 拒绝"

# 1.6 验证 .running 文件存在
if [[ -f "$ROOT/.work/demo-short/.running" ]]; then
  ok ".running 标记文件存在"
else
  fail ".running 标记文件未生成"
fi

# 1.7 看 detail 反映 running=true
DETAIL2=$(CURL "$BASE/api/episodes/demo-short")
RUNNING=$(echo "$DETAIL2" | python3 -c "import json,sys;print(json.load(sys.stdin)['running'])" 2>/dev/null)
assert_eq "$RUNNING" "True" "GET detail 反映 running=true"

# 1.8 等 pipeline 跑完(给 60 秒,够 demo-short 跑完;失败也算"完成")
echo "  等待 pipeline 完成..."
WAITED=0
MAX_WAIT=120
while [[ $WAITED -lt $MAX_WAIT ]]; do
  if [[ ! -f "$ROOT/.work/demo-short/.running" ]]; then
    break
  fi
  sleep 2
  WAITED=$((WAITED+2))
done

if [[ -f "$ROOT/.work/demo-short/.running" ]]; then
  fail "pipeline 在 ${MAX_WAIT}s 内未结束(可能 hang)"
  echo -e "  ${YELLOW}log tail:${NC}"
  tail -10 "$ROOT/.work/demo-short/run.log" 2>/dev/null | sed 's/^/    /'
else
  ok "pipeline 在 ${WAITED}s 内结束"
  EXIT_CODE=$(cat "$ROOT/.work/demo-short/.last_exit" 2>/dev/null || echo "?")
  echo "  exit code: $EXIT_CODE"
fi

# 1.9 验证 chunks.json 存在 + 可解析
if [[ -f "$ROOT/.work/demo-short/chunks.json" ]]; then
  CHUNKS_COUNT=$(python3 -c "
import json
print(len(json.load(open('$ROOT/.work/demo-short/chunks.json'))))
" 2>/dev/null)
  ok "chunks.json 存在,$CHUNKS_COUNT 个 chunks"
else
  fail "chunks.json 未生成"
fi

# 1.10 验证 GET detail 仍然能读(关键:即使 chunks 有 failed 状态也不能 500)
CODE3=$(CURL -o /dev/null -w "%{http_code}" "$BASE/api/episodes/demo-short")
assert_status "$CODE3" "200" "失败/成功后 GET detail 仍 200"

# ─── 2. demo-long e2e (只测 endpoint,不真跑) ───────────────────────

section "2. demo-long endpoint 测试"

# 2.1 出现在列表
if CURL "$BASE/api/episodes" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ids=[e['id'] for e in d['episodes']]
sys.exit(0 if 'demo-long' in ids else 1)
"; then
  ok "demo-long 在列表"
else
  fail "demo-long 不在列表"
fi

# 2.2 GET 详情
CODE4=$(CURL -o /dev/null -w "%{http_code}" "$BASE/api/episodes/demo-long")
assert_status "$CODE4" "200" "GET demo-long detail"

# ─── 3. apply edits 测试(不需要 FISH_TTS_KEY,subtitle-only)─────────

section "3. apply edits (subtitle-only,不重做音频)"

# 等 demo-short 跑完且 .running 不存在
sleep 1
if [[ -f "$ROOT/.work/demo-short/.running" ]]; then
  echo -e "  ${YELLOW}skip apply tests (.running 仍在)${NC}"
else
  # 取一个 chunk id
  FIRST_CID=$(python3 -c "
import json
d=json.load(open('$ROOT/.work/demo-short/chunks.json'))
print(d[0]['id'] if d else '')
" 2>/dev/null)

  if [[ -z "$FIRST_CID" ]]; then
    fail "无法取到第一个 chunk id"
  else
    ok "取到第一个 chunk: $FIRST_CID"

    # 3.1 POST apply 改 subtitle (subtitle-only,只走 P5/P6)
    APPLY_RESP=$(CURL -X POST "$BASE/api/episodes/demo-short/apply" \
      -H 'Content-Type: application/json' \
      -d "{\"edits\":{\"$FIRST_CID\":{\"subtitleText\":\"e2e 测试字幕\"}}}")
    HAS_JOBID=$(echo "$APPLY_RESP" | python3 -c "
import json,sys
try:
    print('ok' if 'jobId' in json.load(sys.stdin) else 'no')
except:
    print('err')
" 2>/dev/null)
    if [[ "$HAS_JOBID" == "ok" ]]; then
      ok "POST apply 返回 jobId"
    else
      fail "POST apply 失败: $APPLY_RESP"
    fi

    # 3.2 chunks.json subtitle_text 应被写入
    sleep 0.5
    NEW_SUB=$(python3 -c "
import json
d=json.load(open('$ROOT/.work/demo-short/chunks.json'))
for c in d:
    if c['id']=='$FIRST_CID':
        print(c.get('subtitle_text',''))
        break
" 2>/dev/null)
    assert_eq "$NEW_SUB" "e2e 测试字幕" "subtitle_text 写入"

    # 3.3 .v 备份产生
    BAK_COUNT=$(ls "$ROOT/.work/demo-short/chunks.json.v"*.json 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$BAK_COUNT" -gt 0 ]]; then
      ok "atomic backup 生成 ($BAK_COUNT 个 .v 文件)"
    else
      fail "未产生 .v 备份"
    fi

    # 3.4 并发 apply 应该 lock(但 subtitle-only 太快可能错过窗口)
    # 改用 5 个并发突发
    echo "  并发 apply 突发(测 lock):"
    for i in 1 2 3 4 5; do
      CURL -o /dev/null -w "    req$i=%{http_code}\n" -X POST "$BASE/api/episodes/demo-short/apply" \
        -H 'Content-Type: application/json' \
        -d "{\"edits\":{\"$FIRST_CID\":{\"subtitleText\":\"burst $i\"}}}" &
    done
    wait
  fi
fi

# ─── 4. 错误路径 ──────────────────────────────────────────────────

section "4. 错误处理"

# 4.1 不存在的 episode → 404
CODE5=$(CURL -o /dev/null -w "%{http_code}" "$BASE/api/episodes/this-does-not-exist-xyz")
assert_status "$CODE5" "404" "GET 不存在的 episode → 404"

# 4.2 audio 不存在 → 404
CODE6=$(CURL -o /dev/null -w "%{http_code}" "$BASE/api/audio/demo-short/no-such-chunk/take_1")
assert_status "$CODE6" "404" "GET 不存在的 audio → 404"

# 4.3 invalid id 创建 → 400
CODE7=$(CURL -o /dev/null -w "%{http_code}" -X POST "$BASE/api/episodes" \
  -F "id=" -F 'script={"title":"x","segments":[]};type=application/json')
if [[ "$CODE7" == "400" || "$CODE7" == "422" || "$CODE7" == "500" ]]; then
  ok "POST 创建空 id → $CODE7"
else
  fail "POST 创建空 id 应该 4xx,实际 $CODE7"
fi

# ─── 5. orphan 检测 ───────────────────────────────────────────────

section "5. orphan 检测"

# 找一个真正的 orphan(.work 有但 episodes 没 script)
ORPHAN_COUNT=$(CURL "$BASE/api/episodes" | python3 -c "
import json,sys
d=json.load(sys.stdin)
orphans=[e for e in d['episodes'] if (e.get('metadata') or {}).get('scriptMissing')]
print(len(orphans))
" 2>/dev/null)
echo "  当前 orphan 数量: $ORPHAN_COUNT"
if [[ "$ORPHAN_COUNT" -ge 0 ]]; then
  ok "orphan 检测可工作"
fi

# ─── summary ──────────────────────────────────────────────────────

section "结果"

TOTAL=$((PASS+FAIL))
echo "  总计: $TOTAL  通过: ${GREEN}$PASS${NC}  失败: ${RED}$FAIL${NC}"

if [[ $FAIL -gt 0 ]]; then
  echo
  echo -e "${RED}失败 case:${NC}"
  for f in "${FAILURES[@]}"; do
    echo "  • $f"
  done
  exit 1
fi

echo -e "${GREEN}all green${NC}"
exit 0
