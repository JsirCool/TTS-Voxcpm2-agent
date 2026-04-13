#!/usr/bin/env node
/**
 * Post-P6 Validation — end-to-end quality check on final output
 *
 * Validates the final per-shot output (audio + subtitles) as a whole,
 * catching issues that per-chunk validation misses.
 *
 * Checks:
 *   1. Subtitle coverage: % of audio duration covered by subtitles (alert if < 80%)
 *   2. Subtitle-audio duration match: last_subtitle.end vs audio_duration (alert if gap > 1s)
 *   3. Inter-chunk subtitle gap: gap > 0.5s between consecutive subtitles is suspicious
 *   4. No overlapping subtitles: sub[i].end > sub[i+1].start
 *
 * Usage:
 *   node scripts/postcheck-p6.js --subtitles <subtitles.json> --durations <durations.json>
 */

const fs = require("fs");

// --- 参数解析 ---
const args = process.argv.slice(2);
let subtitlesPath = "";
let durationsPath = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--subtitles" && args[i + 1]) subtitlesPath = args[++i];
  else if (args[i] === "--durations" && args[i + 1]) durationsPath = args[++i];
}

if (!subtitlesPath || !durationsPath) {
  console.error(
    "Usage: node postcheck-p6.js --subtitles <subtitles.json> --durations <durations.json>"
  );
  process.exit(1);
}

// --- 阈值 ---
const COVERAGE_THRESHOLD = 0.8;     // 80%
const DURATION_GAP_THRESHOLD = 1.0; // 1s
const INTER_SUB_GAP_THRESHOLD = 0.5; // 0.5s

// =============================================================
// Main
// =============================================================

function main() {
  const subtitles = JSON.parse(fs.readFileSync(subtitlesPath, "utf-8"));
  const durations = JSON.parse(fs.readFileSync(durationsPath, "utf-8"));

  // Build duration lookup: shot_id → duration_s
  const durMap = new Map();
  for (const d of durations) {
    durMap.set(d.id, d.duration_s);
  }

  let errors = 0;
  let warnings = 0;

  console.log("=== Post-P6 Validation ===\n");

  for (const [shotId, subs] of Object.entries(subtitles)) {
    if (!Array.isArray(subs) || subs.length === 0) {
      console.log(`  [SKIP] ${shotId}: no subtitles`);
      continue;
    }

    const audioDur = durMap.get(shotId);
    if (audioDur === undefined) {
      console.error(`  ✗ ${shotId}: no duration entry in durations.json`);
      errors++;
      continue;
    }

    console.log(`  [CHECK] ${shotId}: ${subs.length} subtitles, audio ${audioDur.toFixed(2)}s`);

    // --- Check 1: Subtitle coverage ---
    let totalSubTime = 0;
    for (const sub of subs) {
      totalSubTime += Math.max(0, sub.end - sub.start);
    }
    const coverage = audioDur > 0 ? totalSubTime / audioDur : 0;
    if (coverage < COVERAGE_THRESHOLD) {
      console.warn(`    ⚠ coverage ${(coverage * 100).toFixed(1)}% < ${COVERAGE_THRESHOLD * 100}% (sub time ${totalSubTime.toFixed(2)}s / audio ${audioDur.toFixed(2)}s)`);
      warnings++;
    } else {
      console.log(`    ✓ coverage ${(coverage * 100).toFixed(1)}%`);
    }

    // --- Check 2: Subtitle-audio duration match ---
    const lastSub = subs[subs.length - 1];
    const durationGap = audioDur - lastSub.end;
    if (durationGap > DURATION_GAP_THRESHOLD) {
      console.warn(`    ⚠ last subtitle ends at ${lastSub.end.toFixed(2)}s, audio is ${audioDur.toFixed(2)}s (gap ${durationGap.toFixed(2)}s > ${DURATION_GAP_THRESHOLD}s)`);
      warnings++;
    }

    // --- Check 3 & 4: Inter-subtitle gaps and overlaps ---
    for (let i = 0; i < subs.length - 1; i++) {
      const curr = subs[i];
      const next = subs[i + 1];

      // Check 4: Overlapping subtitles (ERROR)
      if (curr.end > next.start + 0.001) { // 1ms tolerance
        console.error(`    ✗ overlap: "${curr.text}" ends at ${curr.end.toFixed(3)}s, "${next.text}" starts at ${next.start.toFixed(3)}s`);
        errors++;
      }

      // Check 3: Suspicious gap (WARNING)
      const gap = next.start - curr.end;
      if (gap > INTER_SUB_GAP_THRESHOLD) {
        console.warn(`    ⚠ gap ${gap.toFixed(2)}s between sub[${i}] and sub[${i + 1}]`);
        warnings++;
      }
    }
  }

  // --- Summary ---
  console.log("");
  if (errors > 0) {
    console.error(`✗ ${errors} error(s), ${warnings} warning(s). Fix errors before proceeding.`);
    process.exit(1);
  } else if (warnings > 0) {
    console.log(`✓ Passed with ${warnings} warning(s).`);
  } else {
    console.log(`✓ All checks passed.`);
  }
}

main();
