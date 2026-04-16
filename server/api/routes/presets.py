from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter

from server.core.domain import DomainError, _CamelBase
from server.core.tts_presets import (
    PresetScope,
    create_preset,
    delete_preset,
    export_preset_document,
    get_preset_file_path,
    import_preset_document,
    load_preset_document,
    set_default_preset,
    update_preset,
)

router = APIRouter(tags=["presets"])


class TtsPresetView(_CamelBase):
    id: str
    scope: PresetScope
    name: str
    config: dict[str, Any]
    created_at: str
    updated_at: str
    is_default: bool = False


class TtsPresetIndexResponse(_CamelBase):
    project_presets: list[TtsPresetView]
    global_presets: list[TtsPresetView]
    default_project_preset_id: str | None = None
    default_global_preset_id: str | None = None
    project_path: str
    global_path: str


class CreatePresetRequest(_CamelBase):
    name: str
    config: dict[str, Any]
    make_default: bool = False


class UpdatePresetRequest(_CamelBase):
    name: str | None = None
    config: dict[str, Any] | None = None
    is_default: bool | None = None


class ImportPresetRequest(_CamelBase):
    scope: PresetScope
    data: dict[str, Any]
    replace: bool = False


class ExportPresetResponse(_CamelBase):
    scope: PresetScope
    data: dict[str, Any]


def _to_view(scope: PresetScope, preset_id: str | None, presets: list[Any]) -> list[TtsPresetView]:
    return [
        TtsPresetView(
            id=preset.id,
            scope=scope,
            name=preset.name,
            config=preset.config,
            created_at=preset.created_at,
            updated_at=preset.updated_at,
            is_default=preset.id == preset_id,
        )
        for preset in presets
    ]


@router.get("/tts-presets", response_model=TtsPresetIndexResponse)
async def list_tts_presets() -> TtsPresetIndexResponse:
    project_doc = load_preset_document("project")
    global_doc = load_preset_document("global")
    return TtsPresetIndexResponse(
        project_presets=_to_view("project", project_doc.default_preset_id, project_doc.presets),
        global_presets=_to_view("global", global_doc.default_preset_id, global_doc.presets),
        default_project_preset_id=project_doc.default_preset_id,
        default_global_preset_id=global_doc.default_preset_id,
        project_path=str(get_preset_file_path("project")),
        global_path=str(get_preset_file_path("global")),
    )


@router.post("/tts-presets/import", response_model=TtsPresetIndexResponse)
async def import_tts_presets(body: ImportPresetRequest) -> TtsPresetIndexResponse:
    import_preset_document(body.scope, body.data, replace=body.replace)
    return await list_tts_presets()


@router.get("/tts-presets/export/{scope}", response_model=ExportPresetResponse)
async def export_tts_presets(scope: PresetScope) -> ExportPresetResponse:
    return ExportPresetResponse(scope=scope, data=export_preset_document(scope))


@router.post("/tts-presets/{scope}", response_model=TtsPresetView, status_code=201)
async def create_tts_preset(scope: PresetScope, body: CreatePresetRequest) -> TtsPresetView:
    record = create_preset(scope, body.name, body.config, make_default=body.make_default)
    doc = load_preset_document(scope)
    return TtsPresetView(
        id=record.id,
        scope=scope,
        name=record.name,
        config=record.config,
        created_at=record.created_at,
        updated_at=record.updated_at,
        is_default=doc.default_preset_id == record.id,
    )


@router.put("/tts-presets/{scope}/{preset_id}", response_model=TtsPresetView)
async def update_tts_preset(scope: PresetScope, preset_id: str, body: UpdatePresetRequest) -> TtsPresetView:
    record = update_preset(
        scope,
        preset_id,
        name=body.name,
        config=body.config,
        is_default=body.is_default,
    )
    doc = load_preset_document(scope)
    return TtsPresetView(
        id=record.id,
        scope=scope,
        name=record.name,
        config=record.config,
        created_at=record.created_at,
        updated_at=record.updated_at,
        is_default=doc.default_preset_id == record.id,
    )


@router.delete("/tts-presets/{scope}/{preset_id}")
async def delete_tts_preset(scope: PresetScope, preset_id: str) -> dict[str, bool]:
    delete_preset(scope, preset_id)
    return {"deleted": True}


@router.post("/tts-presets/{scope}/{preset_id}/default")
async def make_default_tts_preset(scope: PresetScope, preset_id: str) -> dict[str, bool]:
    set_default_preset(scope, preset_id)
    return {"ok": True}
