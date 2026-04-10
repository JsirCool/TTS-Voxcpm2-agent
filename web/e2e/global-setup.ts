import { execSync } from 'child_process';

export default function globalSetup() {
  const ts = new Date().toISOString();
  execSync(`echo "=== E2E START ${ts} ===" >> /tmp/tts-harness-api.log 2>/dev/null || true`);
  execSync(`echo "=== E2E START ${ts} ===" >> /tmp/tts-harness-web.log 2>/dev/null || true`);

  // Verify services are running
  const checks = [
    { url: 'http://localhost:8100/healthz', name: 'FastAPI' },
    { url: 'http://localhost:3010', name: 'Next.js' },
  ];

  for (const { url, name } of checks) {
    try {
      execSync(`curl -sf --noproxy '*' "${url}" > /dev/null 2>&1`, { timeout: 5000 });
    } catch {
      throw new Error(`${name} not running at ${url}. Run: make serve`);
    }
  }

  // Check whisperx (warn but don't fail — P3 will fail at test time with clear error)
  try {
    execSync(`curl -sf --noproxy '*' "http://localhost:7860/healthz" > /dev/null 2>&1`, { timeout: 5000 });
  } catch {
    console.warn('⚠ whisperx-svc not running on :7860 — P3 transcription will fail');
  }
}
