#!/usr/bin/env node
/**
 * P2 — 并行 TTS 合成
 *
 * 读取 chunks.json，对每个 pending chunk 调用 Fish TTS，输出独立 WAV。
 * 支持指定单个 chunk 重做（--chunk <id>）。
 *
 * Usage:
 *   node scripts/p2-synth.js --chunks <chunks.json> --outdir <dir>
 *   node scripts/p2-synth.js --chunks <chunks.json> --outdir <dir> --chunk shot02_chunk01
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { trace } = require("./trace");

// 国内 DNS 会污染 fish.audio,Fish API 必须走代理。
// Node 24+ 原生 fetch 在 NODE_USE_ENV_PROXY=1 时自动读 HTTPS_PROXY/NO_PROXY。
// 这里只确保该 flag 被设置,真正的代理 URL 来自 .env / 环境变量。
if ((process.env.HTTPS_PROXY || process.env.HTTP_PROXY) && !process.env.NODE_USE_ENV_PROXY) {
  process.env.NODE_USE_ENV_PROXY = "1";
}

// --- 配置（env 优先 → config.json → 默认值）---
const _p2Defaults = { concurrency: 3, max_retries: 3, default_speed: 1.0, model: "s1" };
try {
  const _cfg = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", ".harness", "config.json"), "utf-8"));
  if (_cfg.p2) Object.assign(_p2Defaults, _cfg.p2);
} catch {}

const TTS_API_URL = "https://api.fish.audio/v1/tts";
const TTS_API_KEY = process.env.FISH_TTS_KEY;
if (!TTS_API_KEY) {
  console.error("ERROR: FISH_TTS_KEY environment variable is required");
  process.exit(1);
}
const TTS_MODEL = process.env.FISH_TTS_MODEL || _p2Defaults.model;
const TTS_REFERENCE_ID = process.env.FISH_TTS_REFERENCE_ID || "";
const DEFAULT_SPEED = parseFloat(process.env.TTS_SPEED || String(_p2Defaults.default_speed));
const CONCURRENCY = _p2Defaults.concurrency;

// --- 参数解析 ---
const args = process.argv.slice(2);
let chunksPath = "";
let outdir = "";
let targetChunk = "";
let speed = DEFAULT_SPEED;
let tracePath = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--chunks" && args[i + 1]) chunksPath = args[++i];
  else if (args[i] === "--outdir" && args[i + 1]) outdir = args[++i];
  else if (args[i] === "--chunk" && args[i + 1]) targetChunk = args[++i];
  else if (args[i] === "--speed" && args[i + 1]) speed = parseFloat(args[++i]);
  else if (args[i] === "--trace" && args[i + 1]) tracePath = args[++i];
}

if (!chunksPath || !outdir) {
  console.error(
    "Usage: node p2-synth.js --chunks <chunks.json> --outdir <dir> [--chunk <id>] [--speed 1.15]"
  );
  process.exit(1);
}

async function callTTS(text) {
  const payload = { text, model: TTS_MODEL, normalize: false };
  if (TTS_REFERENCE_ID) payload.reference_id = TTS_REFERENCE_ID;
  if (_p2Defaults.temperature != null) payload.temperature = _p2Defaults.temperature;
  if (_p2Defaults.top_p != null) payload.top_p = _p2Defaults.top_p;

  // 用 fetch 而非 https.request,这样 undici 的 ProxyAgent 才能生效
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(TTS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TTS_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`TTS API ${res.status}: ${errBody.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

function applySpeed(inputPath, outputPath, tempo) {
  execSync(
    `ffmpeg -y -i "${inputPath}" -filter:a "atempo=${tempo}" -ar 44100 "${outputPath}" 2>/dev/null`
  );
}

function getAudioDuration(filePath) {
  const out = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
    { encoding: "utf-8" }
  );
  return parseFloat(out.trim());
}

// =============================================================
// 并行控制
// =============================================================

async function processChunk(chunk) {
  const mp3Path = path.join(outdir, `${chunk.id}.mp3`);
  const wavPath = path.join(outdir, `${chunk.id}.wav`);

  console.log(`  [TTS] ${chunk.id}: "${chunk.text_normalized.slice(0, 40)}..."`);

  const t0 = Date.now();
  if (tracePath) trace(tracePath, { chunk: chunk.id, phase: "p2", event: "start" });

  // 重试 3 次
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const audioBuffer = await callTTS(chunk.text_normalized);
      fs.writeFileSync(mp3Path, audioBuffer);
      applySpeed(mp3Path, wavPath, speed);
      fs.unlinkSync(mp3Path);

      const duration = getAudioDuration(wavPath);
      console.log(`    → ${chunk.id}.wav (${duration.toFixed(2)}s)`);

      if (tracePath) trace(tracePath, { chunk: chunk.id, phase: "p2", event: "done", duration_ms: Date.now() - t0 });
      return { id: chunk.id, duration_s: Math.round(duration * 1000) / 1000, file: `${chunk.id}.wav`, status: "synth_done" };
    } catch (e) {
      lastErr = e;
      console.error(`    [RETRY ${attempt}/3] ${chunk.id}: ${e.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }

  console.error(`    [FAIL] ${chunk.id}: ${lastErr.message}`);
  if (tracePath) trace(tracePath, { chunk: chunk.id, phase: "p2", event: "done", duration_ms: Date.now() - t0, error: lastErr.message });
  return { id: chunk.id, duration_s: 0, file: null, status: "synth_failed", error: lastErr.message };
}

async function runWithConcurrency(items, fn, limit) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// =============================================================
// Main
// =============================================================

async function main() {
  const chunks = JSON.parse(fs.readFileSync(chunksPath, "utf-8"));
  fs.mkdirSync(outdir, { recursive: true });

  // 过滤要处理的 chunks
  let toProcess;
  if (targetChunk) {
    toProcess = chunks.filter((c) => c.id === targetChunk);
    if (toProcess.length === 0) {
      console.error(`Chunk "${targetChunk}" not found`);
      process.exit(1);
    }
  } else {
    toProcess = chunks.filter((c) => c.status === "pending" || c.status === "synth_failed");
  }

  console.log(`=== P2: Synthesizing ${toProcess.length} chunk(s), concurrency=${CONCURRENCY}, speed=${speed}x ===\n`);

  const results = await runWithConcurrency(toProcess, processChunk, CONCURRENCY);

  // 更新 chunks.json 的 status
  for (const r of results) {
    const chunk = chunks.find((c) => c.id === r.id);
    if (chunk) {
      chunk.status = r.status;
      chunk.duration_s = r.duration_s;
      chunk.file = r.file;
      if (r.error) chunk.error = r.error;
    }
  }

  fs.writeFileSync(chunksPath, JSON.stringify(chunks, null, 2));

  // 摘要
  const ok = results.filter((r) => r.status === "synth_done").length;
  const fail = results.filter((r) => r.status === "synth_failed").length;
  const totalDur = results.reduce((s, r) => s + r.duration_s, 0);

  console.log(`\n=== Done: ${ok} ok, ${fail} failed, total ${totalDur.toFixed(1)}s ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
