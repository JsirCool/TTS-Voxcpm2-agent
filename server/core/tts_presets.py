from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from server.core.domain import DomainError

PresetScope = Literal["project", "global"]

CONFIG_KEYS = (
    "cfg_value",
    "inference_timesteps",
    "control_prompt",
    "reference_audio_path",
    "prompt_audio_path",
    "prompt_text",
    "normalize",
    "denoise",
)


@dataclass
class TtsPresetRecord:
    id: str
    name: str
    config: dict[str, Any]
    created_at: str
    updated_at: str


@dataclass
class TtsPresetDocument:
    scope: PresetScope
    default_preset_id: str | None
    presets: list[TtsPresetRecord]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _project_path() -> Path:
    raw = os.environ.get("HARNESS_PROJECT_PRESETS_PATH")
    if raw:
        return Path(raw).expanduser().resolve()
    return (_repo_root() / ".harness" / "tts-presets.project.json").resolve()


def _global_path() -> Path:
    raw = os.environ.get("HARNESS_GLOBAL_PRESETS_PATH")
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".tts-agent-harness" / "tts-presets.global.json").resolve()


def get_preset_file_path(scope: PresetScope) -> Path:
    return _project_path() if scope == "project" else _global_path()


def sanitize_tts_config(input_config: dict[str, Any] | None) -> dict[str, Any]:
    config = input_config or {}
    result: dict[str, Any] = {}
    for key in CONFIG_KEYS:
        value = config.get(key)
        if value is None:
            continue
        if isinstance(value, str):
            value = value.strip()
            if not value:
                continue
        result[key] = value
    return result


def validate_tts_config(config: dict[str, Any] | None) -> dict[str, Any]:
    cleaned = sanitize_tts_config(config)
    issues: list[str] = []

    prompt_audio = str(cleaned.get("prompt_audio_path") or "").strip()
    prompt_text = str(cleaned.get("prompt_text") or "").strip()
    if prompt_audio and not prompt_text:
        issues.append("prompt_audio_path 已设置时，prompt_text 也必须填写。")
    if prompt_text and not prompt_audio:
        issues.append("prompt_text 不能单独填写，需同时提供 prompt_audio_path。")

    for field in ("reference_audio_path", "prompt_audio_path"):
        raw = str(cleaned.get(field) or "").strip()
        if not raw:
            continue
        path = Path(raw).expanduser()
        if not path.is_absolute():
            issues.append(f"{field} 必须是本机绝对路径：{raw}")
            continue
        if not path.exists():
            issues.append(f"{field} 不存在：{path}")
            continue
        if not path.is_file():
            issues.append(f"{field} 不是文件：{path}")

    if issues:
        message = "；".join(issues)
        code = "path_not_found" if any("不存在" in item for item in issues) else "invalid_path"
        raise DomainError(code, message)
    return cleaned


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_document(scope: PresetScope) -> TtsPresetDocument:
    return TtsPresetDocument(scope=scope, default_preset_id=None, presets=[])


def _record_from_dict(raw: dict[str, Any]) -> TtsPresetRecord:
    return TtsPresetRecord(
        id=str(raw.get("id") or uuid4()),
        name=str(raw.get("name") or "未命名预设").strip() or "未命名预设",
        config=sanitize_tts_config(raw.get("config") if isinstance(raw.get("config"), dict) else {}),
        created_at=str(raw.get("createdAt") or raw.get("created_at") or _utc_now()),
        updated_at=str(raw.get("updatedAt") or raw.get("updated_at") or _utc_now()),
    )


def load_preset_document(scope: PresetScope) -> TtsPresetDocument:
    path = get_preset_file_path(scope)
    if not path.exists():
        return _empty_document(scope)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise DomainError("invalid_state", f"{scope} 预设文件读取失败：{exc}")
    if not isinstance(payload, dict):
        raise DomainError("invalid_state", f"{scope} 预设文件格式无效")
    presets_raw = payload.get("presets")
    if not isinstance(presets_raw, list):
        presets_raw = []
    presets = [_record_from_dict(item) for item in presets_raw if isinstance(item, dict)]
    default_preset_id = payload.get("defaultPresetId") or payload.get("default_preset_id")
    if default_preset_id and all(preset.id != default_preset_id for preset in presets):
        default_preset_id = presets[0].id if presets else None
    return TtsPresetDocument(
        scope=scope,
        default_preset_id=str(default_preset_id) if default_preset_id else None,
        presets=presets,
    )


def save_preset_document(document: TtsPresetDocument) -> None:
    path = get_preset_file_path(document.scope)
    path.parent.mkdir(parents=True, exist_ok=True)
    if document.default_preset_id and all(preset.id != document.default_preset_id for preset in document.presets):
        document.default_preset_id = document.presets[0].id if document.presets else None
    payload = {
        "version": 1,
        "scope": document.scope,
        "defaultPresetId": document.default_preset_id,
        "presets": [
            {
                "id": preset.id,
                "name": preset.name,
                "config": preset.config,
                "createdAt": preset.created_at,
                "updatedAt": preset.updated_at,
            }
            for preset in document.presets
        ],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def create_preset(scope: PresetScope, name: str, config: dict[str, Any], *, make_default: bool = False) -> TtsPresetRecord:
    cleaned = validate_tts_config(config)
    doc = load_preset_document(scope)
    now = _utc_now()
    record = TtsPresetRecord(
        id=str(uuid4()),
        name=name.strip() or "未命名预设",
        config=cleaned,
        created_at=now,
        updated_at=now,
    )
    doc.presets.append(record)
    if make_default or not doc.default_preset_id:
        doc.default_preset_id = record.id
    save_preset_document(doc)
    return record


def update_preset(
    scope: PresetScope,
    preset_id: str,
    *,
    name: str | None = None,
    config: dict[str, Any] | None = None,
    is_default: bool | None = None,
) -> TtsPresetRecord:
    doc = load_preset_document(scope)
    for index, preset in enumerate(doc.presets):
        if preset.id != preset_id:
            continue
        next_config = preset.config if config is None else validate_tts_config(config)
        next_name = preset.name if name is None else (name.strip() or preset.name)
        updated = TtsPresetRecord(
            id=preset.id,
            name=next_name,
            config=next_config,
            created_at=preset.created_at,
            updated_at=_utc_now(),
        )
        doc.presets[index] = updated
        if is_default:
            doc.default_preset_id = preset_id
        elif is_default is False and doc.default_preset_id == preset_id:
            doc.default_preset_id = doc.presets[0].id if doc.presets else None
        save_preset_document(doc)
        return updated
    raise DomainError("preset_not_found", f"{scope} 预设 '{preset_id}' 不存在")


def delete_preset(scope: PresetScope, preset_id: str) -> None:
    doc = load_preset_document(scope)
    next_presets = [preset for preset in doc.presets if preset.id != preset_id]
    if len(next_presets) == len(doc.presets):
        raise DomainError("preset_not_found", f"{scope} 预设 '{preset_id}' 不存在")
    doc.presets = next_presets
    if doc.default_preset_id == preset_id:
        doc.default_preset_id = next_presets[0].id if next_presets else None
    save_preset_document(doc)


def set_default_preset(scope: PresetScope, preset_id: str) -> None:
    doc = load_preset_document(scope)
    if all(preset.id != preset_id for preset in doc.presets):
        raise DomainError("preset_not_found", f"{scope} 预设 '{preset_id}' 不存在")
    doc.default_preset_id = preset_id
    save_preset_document(doc)


def export_preset_document(scope: PresetScope) -> dict[str, Any]:
    doc = load_preset_document(scope)
    return {
        "version": 1,
        "scope": scope,
        "defaultPresetId": doc.default_preset_id,
        "presets": [
            {
                "id": preset.id,
                "name": preset.name,
                "config": preset.config,
                "createdAt": preset.created_at,
                "updatedAt": preset.updated_at,
                "isDefault": preset.id == doc.default_preset_id,
            }
            for preset in doc.presets
        ],
    }


def import_preset_document(scope: PresetScope, payload: dict[str, Any], *, replace: bool = False) -> TtsPresetDocument:
    doc = _empty_document(scope) if replace else load_preset_document(scope)
    incoming_presets = payload.get("presets", payload)
    if not isinstance(incoming_presets, list):
        raise DomainError("invalid_input", "导入内容必须包含 presets 数组")

    existing_ids = {preset.id for preset in doc.presets}
    imported: list[TtsPresetRecord] = []
    for item in incoming_presets:
        if not isinstance(item, dict):
            continue
        record = _record_from_dict(item)
        record = TtsPresetRecord(
            id=record.id if record.id not in existing_ids else str(uuid4()),
            name=record.name,
            config=validate_tts_config(record.config),
            created_at=record.created_at,
            updated_at=_utc_now(),
        )
        existing_ids.add(record.id)
        imported.append(record)

    if replace:
        doc.presets = imported
    else:
        doc.presets.extend(imported)

    default_preset_id = payload.get("defaultPresetId") or payload.get("default_preset_id")
    if isinstance(default_preset_id, str) and any(preset.id == default_preset_id for preset in doc.presets):
        doc.default_preset_id = default_preset_id
    elif not doc.default_preset_id and doc.presets:
        doc.default_preset_id = doc.presets[0].id

    save_preset_document(doc)
    return doc
