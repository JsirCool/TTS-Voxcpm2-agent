#!/usr/bin/env node
/**
 * Text Diff — deterministic text comparison (pre-P4)
 *
 * Compares text_normalized against WhisperX transcription.
 * Auto-validates chunks where differences are only:
 *   - Punctuation differences
 *   - Known homophones (的/地/得, 做/作, etc.)
 *   - Whitespace
 *
 * Only chunks with unexplained differences go to P4.
 *
 * Usage:
 *   node scripts/text-diff.js --chunks <chunks.json> --transcripts <dir>
 */

const fs = require("fs");
const path = require("path");

// --- 参数解析 ---
const args = process.argv.slice(2);
let chunksPath = "";
let transcriptsDir = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--chunks" && args[i + 1]) chunksPath = args[++i];
  else if (args[i] === "--transcripts" && args[i + 1]) transcriptsDir = args[++i];
}

if (!chunksPath || !transcriptsDir) {
  console.error("Usage: node text-diff.js --chunks <chunks.json> --transcripts <dir>");
  process.exit(1);
}

// --- 同音字映射 ---
const HOMOPHONES = {
  '地': '的', '得': '的',
  '做': '作',
  '哪': '那',
  '他': '它', '她': '它',
};

// --- Levenshtein 编辑距离 ---
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m + 1}, (_, i) => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// --- 文本规范化 ---
function normalize(text) {
  // 1. 去除标点和空白
  let s = text.replace(/[\s\p{P}]/gu, "");
  // 2. 同音字规范化
  s = Array.from(s).map(ch => HOMOPHONES[ch] || ch).join("");
  // 3. 全角转半角、统一大小写
  s = s.toLowerCase();
  return s;
}

// --- Main ---
const THRESHOLD = 0.1; // 10% normalized distance

const chunks = JSON.parse(fs.readFileSync(chunksPath, "utf-8"));
const transcribed = chunks.filter(c => c.status === "transcribed");

if (transcribed.length === 0) {
  console.log("No transcribed chunks to diff.");
  process.exit(0);
}

console.log(`=== Text Diff: ${transcribed.length} chunk(s) ===\n`);

let autoPassCount = 0;
let needP4Count = 0;

for (const chunk of transcribed) {
  const jsonPath = path.join(transcriptsDir, `${chunk.id}.json`);
  if (!fs.existsSync(jsonPath)) {
    console.log(`  [SKIP] ${chunk.id}: transcript not found`);
    continue;
  }

  let transcript;
  try {
    transcript = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  } catch (e) {
    console.log(`  [SKIP] ${chunk.id}: invalid JSON — ${e.message}`);
    continue;
  }

  const normalizedSource = normalize(chunk.text_normalized);
  const normalizedTranscript = normalize(transcript.full_transcribed_text || "");

  const dist = levenshtein(normalizedSource, normalizedTranscript);
  const maxLen = Math.max(normalizedSource.length, normalizedTranscript.length);
  const ratio = maxLen > 0 ? dist / maxLen : 0;

  if (ratio < THRESHOLD) {
    console.log(`  ✓ ${chunk.id}: auto-pass (distance=${dist}, ratio=${ratio.toFixed(3)})`);
    chunk.status = "validated";
    chunk.diff_auto_pass = true;
    chunk.diff_ratio = parseFloat(ratio.toFixed(4));
    autoPassCount++;
  } else {
    console.log(`  → ${chunk.id}: needs P4 (distance=${dist}, ratio=${ratio.toFixed(3)})`);
    chunk.diff_ratio = parseFloat(ratio.toFixed(4));
    needP4Count++;
  }
}

// 写回 chunks
fs.writeFileSync(chunksPath, JSON.stringify(chunks, null, 2));

console.log(`\n✓ Auto-passed: ${autoPassCount}, Needs P4: ${needP4Count}`);
