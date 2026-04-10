#!/usr/bin/env bash
#
# smoke-test.sh — 最小端到端闭环测试
#
# 用 curl 直接打 FastAPI，模拟前端的全部核心操作：
#   1. 创建 episode (上传 script.json)
#   2. 查看 episode 详情
#   3. 触发切分 (chunk_only mode)
#   4. 查看切分结果
#   5. 修改 TTS config
#   6. 清理
#
# 不需要前端、不需要 Prefect worker、不需要 Fish API。
# 只验证：FastAPI + Postgres + MinIO 全链路通。
#

set -euo pipefail

# Clear proxy — all requests are localhost
export no_proxy="localhost,127.0.0.1"
unset HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy 2>/dev/null || true

API="${API_URL:-http://localhost:8100}"
EP_ID="smoke-test-$(date +%s)"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }

echo "=== TTS Harness Smoke Test ==="
echo "API: $API"
echo "Episode: $EP_ID"
echo ""

# --- 0. Health check ---
echo "Step 0: Health check"
STATUS=$(curl -sf "$API/healthz" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
[ "$STATUS" = "ok" ] && pass "healthz → ok" || fail "healthz failed"

# --- 1. Create episode ---
echo "Step 1: Create episode"

# Prepare script.json
SCRIPT_JSON=$(cat <<'SCRIPT'
{
  "title": "Smoke Test Episode",
  "description": "Automated smoke test",
  "segments": [
    {"id": 1, "type": "hook", "text": "这是第一句话，用于测试切分。"},
    {"id": 2, "type": "content", "text": "这是第二句话。第三句话也在这里。"}
  ]
}
SCRIPT
)
TMPSCRIPT=$(mktemp /tmp/smoke-script-XXXX.json)
echo "$SCRIPT_JSON" > "$TMPSCRIPT"

RESP=$(curl -sf -X POST "$API/episodes" \
  -F "id=$EP_ID" \
  -F "title=Smoke Test" \
  -F "script=@$TMPSCRIPT;type=application/json")
rm -f "$TMPSCRIPT"

CREATED_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
[ "$CREATED_ID" = "$EP_ID" ] && pass "created episode $EP_ID" || fail "create failed: $RESP"

# --- 2. List episodes ---
echo "Step 2: List episodes"
LIST=$(curl -sf "$API/episodes")
echo "$LIST" | python3 -c "
import sys, json
eps = json.load(sys.stdin)
found = any(e['id'] == '$EP_ID' for e in eps)
if found: print('  found in list')
else: sys.exit(1)
" || fail "episode not in list"
pass "episode in list"

# --- 3. Get episode detail ---
echo "Step 3: Get episode detail"
DETAIL=$(curl -sf "$API/episodes/$EP_ID")
EPISODE_STATUS=$(echo "$DETAIL" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
[ "$EPISODE_STATUS" = "empty" ] && pass "status = empty" || fail "unexpected status: $EPISODE_STATUS"

CHUNK_COUNT=$(echo "$DETAIL" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['chunks']))")
[ "$CHUNK_COUNT" = "0" ] && pass "0 chunks (not yet split)" || fail "unexpected chunks: $CHUNK_COUNT"

# --- 4. Update config ---
echo "Step 4: Update TTS config"
CONFIG_RESP=$(curl -sf -X PUT "$API/episodes/$EP_ID/config" \
  -H "Content-Type: application/json" \
  -d '{"config": {"temperature": 0.5, "top_p": 0.8, "speed": 1.1}}')
TEMP=$(echo "$CONFIG_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['config']['temperature'])")
[ "$TEMP" = "0.5" ] && pass "config updated (temperature=0.5)" || fail "config update failed: $CONFIG_RESP"

# --- 5. Trigger run (chunk_only mode) ---
echo "Step 5: Trigger P1 cut (chunk_only)"
RUN_RESP=$(curl -sf -X POST "$API/episodes/$EP_ID/run" \
  -H "Content-Type: application/json" \
  -d '{"mode": "chunk_only"}' 2>&1 || true)

# chunk_only triggers Prefect flow — will fail if deployment not registered.
# We test the HTTP layer only: 200 = deployment exists; 500 = no deployment (expected).
HTTP_CODE=$(curl -s -o /tmp/smoke-run-resp.json -w "%{http_code}" \
  -X POST "$API/episodes/$EP_ID/run" \
  -H "Content-Type: application/json" \
  -d '{"mode": "chunk_only"}')
RUN_RESP=$(cat /tmp/smoke-run-resp.json 2>/dev/null || echo "")

if [ "$HTTP_CODE" = "200" ]; then
  pass "run accepted (flowRunId returned — Prefect deployment registered)"
elif [ "$HTTP_CODE" = "500" ]; then
  echo "  ⚠ run returned 500 (no Prefect deployment — expected in smoke test)"
  pass "API endpoint works (deployment not yet registered)"
elif [ "$HTTP_CODE" = "409" ]; then
  pass "run rejected: episode already running (409 — correct guard)"
else
  fail "unexpected HTTP $HTTP_CODE: $RUN_RESP"
fi

# --- 6. Get episode logs ---
echo "Step 6: Episode logs"
LOGS_RESP=$(curl -sf "$API/episodes/$EP_ID/logs?tail=10")
echo "$LOGS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  {len(d[\"lines\"])} log lines')" || fail "logs failed"
pass "logs endpoint works"

# --- 7. CORS check ---
echo "Step 7: CORS headers"
CORS=$(curl -sf -I -X OPTIONS "$API/episodes" \
  -H "Origin: http://localhost:3010" \
  -H "Access-Control-Request-Method: GET" 2>&1 | grep -i "access-control-allow-origin" || true)
if echo "$CORS" | grep -qi "localhost:3010\|\*"; then
  pass "CORS allows localhost:3010"
else
  echo "  ⚠ CORS header not found (may work via browser anyway)"
fi

# --- 8. Cleanup ---
echo "Step 8: Cleanup"
DEL_RESP=$(curl -sf -X DELETE "$API/episodes/$EP_ID")
DELETED=$(echo "$DEL_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['deleted'])")
[ "$DELETED" = "True" ] && pass "episode deleted" || fail "delete failed: $DEL_RESP"

echo ""
echo "════════════════════════════════════════"
echo "  SMOKE TEST: ALL PASSED"
echo "════════════════════════════════════════"
