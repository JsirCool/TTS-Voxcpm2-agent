import { execSync } from 'child_process';

export default function globalTeardown() {
  const dest = 'test-results/server-logs';
  try {
    execSync(`mkdir -p ${dest}`);
    execSync(`cp /tmp/tts-harness-api.log ${dest}/fastapi.log 2>/dev/null || true`);
    execSync(`cp /tmp/tts-harness-web.log ${dest}/nextjs.log 2>/dev/null || true`);
    execSync(`docker logs whisperx-svc > ${dest}/whisperx.log 2>&1 || true`);
  } catch {
    // Best effort — don't fail teardown
  }
}
