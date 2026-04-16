# Windows Local Start

## One-click start

Double-click:

- `start-local-stack.bat`

What it does:

1. Starts Docker infra: Postgres + MinIO
2. Runs Alembic migrations
3. Checks Web dependencies
4. Opens 4 command windows:
   - `VoxCPM`
   - `WhisperX`
   - `API`
   - `Web`
5. Opens the browser to `http://localhost:3010`

## One-click stop

Double-click:

- `stop-local-stack.bat`

It kills local processes on ports:

- `3010`
- `7860`
- `8100`
- `8877`

and then stops Docker infra.

## URLs

- Web: `http://localhost:3010`
- API: `http://localhost:8100`
- API docs: `http://localhost:8100/docs`
- VoxCPM health: `http://127.0.0.1:8877/healthz`
- WhisperX health: `http://127.0.0.1:7860/healthz`
- MinIO console: `http://localhost:59001`

## Start a single service manually

You can also double-click any one of these:

- `scripts\windows\run-voxcpm-svc.bat`
- `scripts\windows\run-whisperx-svc.bat`
- `scripts\windows\run-api.bat`
- `scripts\windows\run-web.bat`

## First-time checks

If your paths are different, edit:

- `scripts\windows\_env.bat`

The most important values are:

- `VENV_PY`
- `VOXCPM_MODEL_PATH`
- `HF_HOME`

## Notes

- WhisperX may take `10-60` seconds to load on first start.
- The Web dependency install uses `pnpm` and the Yarn registry because this machine had repeated `npm`/`npmjs` network resets.
