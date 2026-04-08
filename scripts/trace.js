// Usage in other scripts:
// const { trace } = require("./trace");
// trace(tracePath, { chunk: "shot02_chunk01", phase: "p2", event: "start" });
// trace(tracePath, { chunk: "shot02_chunk01", phase: "p2", event: "done", duration_ms: 13200 });

const fs = require("fs");

function trace(tracePath, data) {
  const entry = { ts: new Date().toISOString(), ...data };
  fs.appendFileSync(tracePath, JSON.stringify(entry) + "\n");
}

function summary(tracePath) {
  if (!fs.existsSync(tracePath)) return;
  const lines = fs.readFileSync(tracePath, "utf-8").trim().split("\n").map(JSON.parse);

  // Per-phase stats
  const phases = {};
  for (const l of lines) {
    if (l.event !== "done") continue;
    if (!phases[l.phase]) phases[l.phase] = { count: 0, total_ms: 0, errors: 0 };
    phases[l.phase].count++;
    phases[l.phase].total_ms += l.duration_ms || 0;
    if (l.error) phases[l.phase].errors++;
  }

  console.log("\n=== Pipeline Trace Summary ===");
  for (const [phase, stats] of Object.entries(phases)) {
    const avg = stats.count ? Math.round(stats.total_ms / stats.count) : 0;
    console.log(`  ${phase}: ${stats.count} done, avg ${avg}ms, ${stats.errors} errors`);
  }
}

module.exports = { trace, summary };
