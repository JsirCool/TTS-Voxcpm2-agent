#!/usr/bin/env node
/**
 * Repair 循环测试 — 读取 fixture scenario，验证修复流程
 *
 * Usage: node test/repair/run-repair-tests.js
 */

const fs = require("fs");
const path = require("path");

const FIXTURE_DIR = path.join(__dirname, "../fixtures/repair");

// 发现所有 tc-* 目录
const scenarios = fs.readdirSync(FIXTURE_DIR)
  .filter(d => d.startsWith("tc-") && fs.statSync(path.join(FIXTURE_DIR, d)).isDirectory())
  .sort();

let pass = 0, fail = 0;

for (const dir of scenarios) {
  const scenarioPath = path.join(FIXTURE_DIR, dir, "scenario.json");
  if (!fs.existsSync(scenarioPath)) {
    console.log(`  SKIP ${dir} (no scenario.json)`);
    continue;
  }

  const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf-8"));
  console.log(`  ${dir}: ${scenario.description}`);

  // TODO: Phase 4 实现时补充实际的 repair 循环执行逻辑
  // 当前只验证 fixture 格式正确
  const valid = scenario.chunk && scenario.expected && scenario.attempts;
  if (valid) {
    console.log(`    ✓ fixture valid (${scenario.attempts.length} attempts defined)`);
    pass++;
  } else {
    console.log(`    ✗ fixture invalid`);
    fail++;
  }
}

console.log(`\n=== Repair Fixtures: ${pass} valid, ${fail} invalid ===`);
process.exit(fail > 0 ? 1 : 0);
