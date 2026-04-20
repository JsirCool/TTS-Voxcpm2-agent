from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncEngine


TRUTHY = {"1", "true", "yes", "on"}


def is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in TRUTHY


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def desktop_mode_enabled() -> bool:
    return is_truthy(os.environ.get("HARNESS_DESKTOP_MODE"))


def desktop_root() -> Path:
    raw = os.environ.get("HARNESS_DESKTOP_ROOT")
    if raw:
        return Path(raw).expanduser().resolve()
    return (repo_root() / ".desktop-runtime").resolve()


def apply_desktop_defaults() -> Path:
    root = desktop_root()
    os.environ.setdefault("HARNESS_DESKTOP_ROOT", str(root))
    data_dir = root / "data"
    storage_dir = data_dir / "storage"
    db_path = data_dir / "harness.db"

    os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{db_path.as_posix()}")
    os.environ.setdefault("STORAGE_MODE", "local_fs")
    os.environ.setdefault("HARNESS_LOCAL_STORAGE_DIR", str(storage_dir))
    os.environ.setdefault("HARNESS_STORAGE_MIRROR_DIR", str(root / "storage-mirror"))
    os.environ.setdefault("TTS_USE_PREFECT", "0")
    return root


def ensure_desktop_directories() -> Path:
    root = apply_desktop_defaults()
    (root / "data").mkdir(parents=True, exist_ok=True)
    Path(os.environ["HARNESS_LOCAL_STORAGE_DIR"]).expanduser().resolve().mkdir(parents=True, exist_ok=True)
    Path(os.environ["HARNESS_STORAGE_MIRROR_DIR"]).expanduser().resolve().mkdir(parents=True, exist_ok=True)
    return root


async def ensure_sqlite_schema(engine: AsyncEngine) -> None:
    from server.core.models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

