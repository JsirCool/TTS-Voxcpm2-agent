from __future__ import annotations

import json
import os
import mimetypes
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qs, quote, urlparse
import re

import httpx

from server.core.domain import DomainError
from server.core.media_processing import probe_media
from server.core.tts_presets import get_voice_source_dir, to_relative_audio_path
from third_party.bili23.helpers import aid_to_bvid, build_wbi_query

BilibiliDownloadTarget = Literal["video", "audio"]
BilibiliMediaType = Literal["video", "audio"]

_SUPPORTED_NETLOCS = {
    "www.bilibili.com",
    "bilibili.com",
    "m.bilibili.com",
    "b23.tv",
    "www.b23.tv",
}
_BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")
_AV_RE = re.compile(r"av(\d+)", re.IGNORECASE)

_REQUEST_HEADERS = {
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/135.0.0.0 Safari/537.36"
    ),
}


@dataclass
class BilibiliImportResult:
    absolute_path: Path
    relative_source_path: str
    media_type: BilibiliMediaType
    title: str
    owner: str | None
    duration_s: float
    download_target: BilibiliDownloadTarget


@dataclass
class BilibiliTarget:
    normalized_url: str
    bvid: str
    page_number: int


@dataclass
class BilibiliEpisodePage:
    cid: int
    page_number: int
    part_title: str
    duration_s: float


@dataclass
class BilibiliSubtitleTrack:
    lan: str
    lan_doc: str
    subtitle_url: str


@dataclass
class BilibiliSourceSidecar:
    bvid: str
    cid: int
    page_number: int
    normalized_url: str
    title: str
    owner: str | None
    duration_s: float
    subtitle_tracks: list[BilibiliSubtitleTrack]


def bilibili_status() -> bool:
    return True


def is_supported_bilibili_url(value: str) -> bool:
    raw = (value or "").strip()
    if not raw:
        return False
    try:
        parsed = urlparse(raw)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and parsed.netloc.lower() in _SUPPORTED_NETLOCS


def extract_video_target(url: str) -> BilibiliTarget:
    raw = (url or "").strip()
    if not is_supported_bilibili_url(raw):
        raise DomainError("invalid_input", "只支持公开可访问的 B 站视频链接或 b23 短链")
    parsed = urlparse(raw)
    query = parse_qs(parsed.query)
    page_number = 1
    try:
        if query.get("p"):
            page_number = max(1, int(query["p"][0]))
    except (TypeError, ValueError):
        page_number = 1

    match = _BV_RE.search(raw)
    if match:
        return BilibiliTarget(normalized_url=raw, bvid=match.group(1), page_number=page_number)

    match = _AV_RE.search(raw)
    if match:
        return BilibiliTarget(
            normalized_url=raw,
            bvid=aid_to_bvid(int(match.group(1))),
            page_number=page_number,
        )

    raise DomainError("invalid_input", "无法从链接中解析 BV/AV 视频编号")


def build_bilibili_cache_relative_path(
    bvid: str,
    *,
    page_number: int,
    download_target: BilibiliDownloadTarget,
    suffix: str,
) -> Path:
    return (
        Path("imported")
        / "bilibili"
        / bvid
        / download_target
        / f"p{page_number:02d}{suffix}"
    )


def resolve_imported_source_path(relative_path: str | Path) -> Path:
    source_root = get_voice_source_dir().resolve()
    imported_root = (source_root / "imported").resolve()
    raw = str(relative_path or "").strip()
    if not raw:
        raise DomainError("invalid_input", "source_relative_path 不能为空")
    candidate = (source_root / raw).resolve(strict=False)
    try:
        candidate.relative_to(imported_root)
    except ValueError as exc:
        raise DomainError("invalid_input", "只允许访问 voice_sourse/imported 下的素材文件") from exc
    if not candidate.exists():
        raise DomainError("not_found", f"素材不存在：{raw}")
    if not candidate.is_file():
        raise DomainError("invalid_input", f"素材不是文件：{raw}")
    return candidate


def guess_media_type(path: Path) -> str:
    content_type, _ = mimetypes.guess_type(str(path))
    return content_type or "application/octet-stream"


def build_preview_url(relative_path: str) -> str:
    return f"/media/source?path={quote(relative_path, safe='')}"


def build_bilibili_source_sidecar_path(media_path: Path) -> Path:
    return media_path.with_suffix(".source.json")


def _normalize_subtitle_url(value: str) -> str:
    url = value.strip()
    if url.startswith("//"):
        return f"https:{url}"
    return url


def _serialize_bilibili_sidecar(sidecar: BilibiliSourceSidecar) -> dict[str, Any]:
    return {
        "version": 1,
        "source": "bilibili",
        "bvid": sidecar.bvid,
        "cid": sidecar.cid,
        "pageNumber": sidecar.page_number,
        "normalizedUrl": sidecar.normalized_url,
        "title": sidecar.title,
        "owner": sidecar.owner,
        "durationS": sidecar.duration_s,
        "subtitleTracks": [
            {
                "lan": track.lan,
                "lanDoc": track.lan_doc,
                "subtitleUrl": track.subtitle_url,
            }
            for track in sidecar.subtitle_tracks
        ],
    }


def _save_bilibili_sidecar(media_path: Path, sidecar: BilibiliSourceSidecar) -> None:
    destination = build_bilibili_source_sidecar_path(media_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(_serialize_bilibili_sidecar(sidecar), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_bilibili_source_sidecar(relative_source_path: str | Path) -> dict[str, Any] | None:
    media_path = resolve_imported_source_path(relative_source_path)
    sidecar_path = build_bilibili_source_sidecar_path(media_path)
    if not sidecar_path.exists():
        return None
    try:
        payload = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - corrupt file is rare
        raise DomainError("invalid_state", f"B 站源信息 sidecar 读取失败：{exc}") from exc
    if not isinstance(payload, dict):
        raise DomainError("invalid_state", "B 站源信息 sidecar 格式无效")
    return payload


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _build_bilibili_subprocess_env(repo_root: Path) -> dict[str, str]:
    allowed = {
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "PROGRAMDATA",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_IDENTIFIER",
        "OS",
    }
    env = {key: value for key, value in os.environ.items() if key in allowed and value}
    env["PYTHONPATH"] = str(repo_root)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def _ffmpeg_executable() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise DomainError("ffmpeg_unavailable", "ffmpeg 未安装，无法合并或转码 B 站素材")
    return ffmpeg


def _request_text_or_json(
    client: httpx.Client,
    url: str,
    *,
    expect_json: bool = True,
) -> dict[str, Any] | str:
    try:
        response = client.get(url, headers=_REQUEST_HEADERS, timeout=30, follow_redirects=True)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise DomainError("bilibili_unavailable", f"B 站请求失败：{type(exc).__name__}: {exc}") from exc
    if expect_json:
        try:
            return response.json()
        except ValueError as exc:
            raise DomainError("bilibili_unavailable", "B 站接口返回了无效 JSON") from exc
    return response.text


def _resolve_short_link(client: httpx.Client, url: str) -> str:
    try:
        response = client.get(url, headers=_REQUEST_HEADERS, timeout=20, follow_redirects=True)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise DomainError("bilibili_unavailable", f"解析 b23 短链失败：{type(exc).__name__}: {exc}") from exc
    return str(response.url)


def _normalize_url(client: httpx.Client, url: str) -> str:
    parsed = urlparse(url)
    if parsed.netloc.lower() in {"b23.tv", "www.b23.tv"}:
        return _resolve_short_link(client, url)
    return url


def _extract_wbi_keys(payload: dict[str, Any]) -> tuple[str, str]:
    data = payload.get("data")
    if not isinstance(data, dict):
        raise DomainError("bilibili_unavailable", "B 站导航接口缺少 data 字段")
    wbi_img = data.get("wbi_img")
    if not isinstance(wbi_img, dict):
        raise DomainError("bilibili_unavailable", "B 站导航接口缺少 wbi_img 字段")
    img_url = str(wbi_img.get("img_url") or "")
    sub_url = str(wbi_img.get("sub_url") or "")
    if not img_url or not sub_url:
        raise DomainError("bilibili_unavailable", "B 站导航接口缺少 WBI 签名所需的密钥")
    img_key = Path(urlparse(img_url).path).stem
    sub_key = Path(urlparse(sub_url).path).stem
    if not img_key or not sub_key:
        raise DomainError("bilibili_unavailable", "B 站导航接口返回的 WBI 密钥无效")
    return img_key, sub_key


def _fetch_nav_keys(client: httpx.Client) -> tuple[str, str]:
    payload = _request_text_or_json(client, "https://api.bilibili.com/x/web-interface/nav")
    if not isinstance(payload, dict):
        raise DomainError("bilibili_unavailable", "B 站导航接口返回了异常结果")
    return _extract_wbi_keys(payload)


def _get_response_data(payload: dict[str, Any], *, path: tuple[str, ...] = ("data",)) -> dict[str, Any]:
    code = int(payload.get("code", -1))
    if code != 0:
        message = str(payload.get("message") or "B 站接口返回异常")
        raise DomainError("bilibili_unavailable", message)
    value: Any = payload
    for key in path:
        if not isinstance(value, dict) or key not in value:
            raise DomainError("bilibili_unavailable", "B 站接口返回缺少必要字段")
        value = value[key]
    if not isinstance(value, dict):
        raise DomainError("bilibili_unavailable", "B 站接口返回的 data 字段无效")
    return value


def _fetch_video_metadata(client: httpx.Client, bvid: str) -> dict[str, Any]:
    payload = _request_text_or_json(
        client,
        f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}",
    )
    if not isinstance(payload, dict):
        raise DomainError("bilibili_unavailable", "B 站元数据接口返回了异常结果")
    return _get_response_data(payload)


def _select_page(metadata: dict[str, Any], *, page_number: int) -> BilibiliEpisodePage:
    pages = metadata.get("pages")
    if isinstance(pages, list) and pages:
        for page in pages:
            if not isinstance(page, dict):
                continue
            if int(page.get("page", 0) or 0) == page_number:
                return BilibiliEpisodePage(
                    cid=int(page.get("cid") or 0),
                    page_number=page_number,
                    part_title=str(page.get("part") or "").strip(),
                    duration_s=float(page.get("duration") or 0),
                )
        raise DomainError("invalid_input", f"该视频不存在第 {page_number} P")

    cid = int(metadata.get("cid") or 0)
    if cid <= 0:
        raise DomainError("bilibili_unavailable", "B 站视频元数据中缺少 cid")
    return BilibiliEpisodePage(
        cid=cid,
        page_number=1,
        part_title="",
        duration_s=float(metadata.get("duration") or 0),
    )


def _fetch_playurl(client: httpx.Client, *, bvid: str, cid: int) -> dict[str, Any]:
    img_key, sub_key = _fetch_nav_keys(client)
    query = build_wbi_query(
        {
            "bvid": bvid,
            "cid": cid,
            "qn": 127,
            "fnver": 0,
            "fnval": 4048,
            "fourk": 1,
        },
        img_key=img_key,
        sub_key=sub_key,
    )
    payload = _request_text_or_json(
        client,
        f"https://api.bilibili.com/x/player/wbi/playurl?{query}",
    )
    if not isinstance(payload, dict):
        raise DomainError("bilibili_unavailable", "B 站播放地址接口返回了异常结果")
    return _get_response_data(payload)


def _fetch_subtitle_tracks(client: httpx.Client, *, bvid: str, cid: int) -> list[BilibiliSubtitleTrack]:
    payload = _request_text_or_json(
        client,
        f"https://api.bilibili.com/x/player/v2?bvid={bvid}&cid={cid}",
    )
    if not isinstance(payload, dict):
        raise DomainError("bilibili_unavailable", "B 站字幕接口返回了异常结果")
    data = _get_response_data(payload)
    subtitle = data.get("subtitle")
    if not isinstance(subtitle, dict):
        return []
    items = subtitle.get("subtitles")
    if not isinstance(items, list):
        return []
    tracks: list[BilibiliSubtitleTrack] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        subtitle_url = _normalize_subtitle_url(str(item.get("subtitle_url") or item.get("url") or ""))
        if not subtitle_url:
            continue
        tracks.append(
            BilibiliSubtitleTrack(
                lan=str(item.get("lan") or "").strip(),
                lan_doc=str(item.get("lan_doc") or "").strip(),
                subtitle_url=subtitle_url,
            )
        )
    return tracks


def _pick_video_stream(playurl: dict[str, Any]) -> dict[str, Any]:
    dash = playurl.get("dash")
    if not isinstance(dash, dict):
        raise DomainError("bilibili_unavailable", "当前视频未返回 DASH 流，无法导入")
    videos = dash.get("video")
    if not isinstance(videos, list) or not videos:
        raise DomainError("bilibili_unavailable", "当前视频没有可下载的视频流")
    candidates = [entry for entry in videos if isinstance(entry, dict) and entry.get("baseUrl")]
    if not candidates:
        raise DomainError("bilibili_unavailable", "当前视频没有可用的视频下载地址")
    candidates.sort(key=lambda item: (int(item.get("id") or 0), int(item.get("bandwidth") or 0)), reverse=True)
    return candidates[0]


def _pick_audio_stream(playurl: dict[str, Any]) -> dict[str, Any]:
    dash = playurl.get("dash")
    if not isinstance(dash, dict):
        raise DomainError("bilibili_unavailable", "当前视频未返回 DASH 音频流")

    candidates: list[dict[str, Any]] = []

    flac = dash.get("flac")
    if isinstance(flac, dict) and isinstance(flac.get("audio"), dict):
        candidates.append(flac["audio"])

    dolby = dash.get("dolby")
    if isinstance(dolby, dict) and isinstance(dolby.get("audio"), list):
        candidates.extend(item for item in dolby["audio"] if isinstance(item, dict))

    regular_audio = dash.get("audio")
    if isinstance(regular_audio, list):
        candidates.extend(item for item in regular_audio if isinstance(item, dict))

    candidates = [item for item in candidates if item.get("baseUrl")]
    if not candidates:
        raise DomainError("bilibili_unavailable", "当前视频没有可用的音频下载地址")

    candidates.sort(key=lambda item: (int(item.get("id") or 0), int(item.get("bandwidth") or 0)), reverse=True)
    return candidates[0]


def _stream_candidates(entry: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for key in ("baseUrl", "base_url"):
        value = entry.get(key)
        if isinstance(value, str) and value:
            urls.append(value)
    for key in ("backupUrl", "backup_url"):
        values = entry.get(key)
        if isinstance(values, list):
            urls.extend(item for item in values if isinstance(item, str) and item)
    deduped: list[str] = []
    for url in urls:
        if url not in deduped:
            deduped.append(url)
    return deduped


def _download_stream(client: httpx.Client, entry: dict[str, Any], output_path: Path) -> None:
    errors: list[str] = []
    for url in _stream_candidates(entry):
        try:
            with client.stream("GET", url, headers=_REQUEST_HEADERS, timeout=120) as response:
                response.raise_for_status()
                with output_path.open("wb") as stream:
                    for chunk in response.iter_bytes():
                        if chunk:
                            stream.write(chunk)
            return
        except httpx.HTTPError as exc:
            errors.append(f"{type(exc).__name__}: {exc}")
            try:
                output_path.unlink(missing_ok=True)
            except OSError:
                pass
    detail = "; ".join(errors[:3]) if errors else "未知下载错误"
    raise DomainError("bilibili_unavailable", f"B 站流下载失败：{detail}")


def _run_ffmpeg(cmd: list[str], *, code: str, prefix: str) -> None:
    completed = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()[:400]
        raise DomainError(code, f"{prefix}: {detail or 'unknown ffmpeg error'}")


def _merge_video_audio(video_path: Path, audio_path: Path, output_path: Path) -> None:
    ffmpeg = _ffmpeg_executable()
    _run_ffmpeg(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-i",
            str(video_path),
            "-i",
            str(audio_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-shortest",
            str(output_path),
        ],
        code="media_process_failed",
        prefix="ffmpeg merge failed",
    )


def _convert_audio_to_wav(audio_path: Path, output_path: Path) -> None:
    ffmpeg = _ffmpeg_executable()
    _run_ffmpeg(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-i",
            str(audio_path),
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ],
        code="media_process_failed",
        prefix="ffmpeg audio conversion failed",
    )


def _normalize_title(base_title: str, page: BilibiliEpisodePage, *, total_pages: int) -> str:
    title = base_title.strip()
    if total_pages <= 1:
        return title
    if page.part_title:
        return f"{title} - P{page.page_number} {page.part_title}"
    return f"{title} - P{page.page_number}"


def _reuse_if_exists(
    destination: Path,
    *,
    title: str,
    owner: str | None,
    download_target: BilibiliDownloadTarget,
) -> BilibiliImportResult | None:
    if not destination.exists():
        return None
    probe = probe_media(destination)
    media_type: BilibiliMediaType = "video" if download_target == "video" else "audio"
    return BilibiliImportResult(
        absolute_path=destination,
        relative_source_path=to_relative_audio_path(destination) or destination.name,
        media_type=media_type,
        title=title,
        owner=owner,
        duration_s=probe.duration_s,
        download_target=download_target,
    )


def _preferred_subtitle_track(payload: dict[str, Any]) -> dict[str, Any] | None:
    tracks = payload.get("subtitleTracks")
    if not isinstance(tracks, list) or not tracks:
        return None

    def _priority(track: dict[str, Any]) -> tuple[int, str]:
        lan = str(track.get("lan") or "").lower()
        lan_doc = str(track.get("lanDoc") or "").lower()
        if lan.startswith("zh") or "中文" in lan_doc:
            return (0, lan)
        if lan.startswith("en") or "英文" in lan_doc or "english" in lan_doc:
            return (1, lan)
        return (2, lan)

    normalized = [track for track in tracks if isinstance(track, dict) and str(track.get("subtitleUrl") or "").strip()]
    if not normalized:
        return None
    normalized.sort(key=_priority)
    return normalized[0]


def resolve_bilibili_official_subtitles(relative_source_path: str | Path) -> tuple[str, list[dict[str, Any]]] | None:
    payload = load_bilibili_source_sidecar(relative_source_path)
    if payload is None:
        return None
    track = _preferred_subtitle_track(payload)
    if track is None:
        return None

    try:
        response = httpx.get(
            str(track["subtitleUrl"]),
            headers=_REQUEST_HEADERS,
            timeout=30,
            follow_redirects=True,
        )
        response.raise_for_status()
        subtitle_payload = response.json()
    except Exception as exc:  # noqa: BLE001
        raise DomainError("subtitle_unavailable", f"B 站官方字幕下载失败：{type(exc).__name__}: {exc}") from exc

    body = subtitle_payload.get("body")
    if not isinstance(body, list):
        return None
    cues: list[dict[str, Any]] = []
    for index, item in enumerate(body, start=1):
        if not isinstance(item, dict):
            continue
        text = str(item.get("content") or "").strip()
        if not text:
            continue
        try:
            start_s = round(float(item.get("from")), 3)
            end_s = round(float(item.get("to")), 3)
        except (TypeError, ValueError):
            continue
        if end_s <= start_s:
            continue
        cues.append(
            {
                "id": f"cue_{index:03d}",
                "start_s": start_s,
                "end_s": end_s,
                "text": text,
            }
        )
    if not cues:
        return None
    language = str(track.get("lan") or payload.get("language") or "zh").strip() or "zh"
    return language, cues


def import_bilibili_media(
    url: str,
    *,
    download_target: BilibiliDownloadTarget,
    voice_source_dir: Path | None = None,
) -> BilibiliImportResult:
    if download_target not in {"video", "audio"}:
        raise DomainError("invalid_input", "download_target 只能是 video 或 audio")

    voice_dir = (voice_source_dir or get_voice_source_dir()).resolve()
    last_error: DomainError | None = None

    for trust_env in (True, False):
        try:
            with httpx.Client(follow_redirects=True, timeout=30, trust_env=trust_env) as client:
                normalized_url = _normalize_url(client, url)
                target = extract_video_target(normalized_url)
                metadata = _fetch_video_metadata(client, target.bvid)
                page = _select_page(metadata, page_number=target.page_number)
                title = _normalize_title(
                    str(metadata.get("title") or target.bvid),
                    page,
                    total_pages=len(metadata.get("pages") or []) if isinstance(metadata.get("pages"), list) else 1,
                )
                owner = None
                if isinstance(metadata.get("owner"), dict):
                    owner = str(metadata["owner"].get("name") or "").strip() or None
                subtitle_tracks = _fetch_subtitle_tracks(client, bvid=target.bvid, cid=page.cid)

                suffix = ".mp4" if download_target == "video" else ".wav"
                relative_path = build_bilibili_cache_relative_path(
                    target.bvid,
                    page_number=page.page_number,
                    download_target=download_target,
                    suffix=suffix,
                )
                destination = (voice_dir / relative_path).resolve()
                destination.parent.mkdir(parents=True, exist_ok=True)

                reused = _reuse_if_exists(
                    destination,
                    title=title,
                    owner=owner,
                    download_target=download_target,
                )
                if reused is not None:
                    _save_bilibili_sidecar(
                        destination,
                        BilibiliSourceSidecar(
                            bvid=target.bvid,
                            cid=page.cid,
                            page_number=page.page_number,
                            normalized_url=normalized_url,
                            title=title,
                            owner=owner,
                            duration_s=reused.duration_s or page.duration_s,
                            subtitle_tracks=subtitle_tracks,
                        ),
                    )
                    return reused

                playurl = _fetch_playurl(client, bvid=target.bvid, cid=page.cid)
                audio_stream = _pick_audio_stream(playurl)

                with tempfile.TemporaryDirectory(prefix="tts-bilibili-") as temp_dir:
                    workspace = Path(temp_dir)
                    temp_audio = workspace / "audio.m4s"
                    _download_stream(client, audio_stream, temp_audio)

                    if download_target == "video":
                        video_stream = _pick_video_stream(playurl)
                        temp_video = workspace / "video.m4s"
                        temp_output = workspace / "merged.mp4"
                        _download_stream(client, video_stream, temp_video)
                        _merge_video_audio(temp_video, temp_audio, temp_output)
                        shutil.copyfile(temp_output, destination)
                    else:
                        temp_output = workspace / "audio.wav"
                        _convert_audio_to_wav(temp_audio, temp_output)
                        shutil.copyfile(temp_output, destination)

            probe = probe_media(destination)
            _save_bilibili_sidecar(
                destination,
                BilibiliSourceSidecar(
                    bvid=target.bvid,
                    cid=page.cid,
                    page_number=page.page_number,
                    normalized_url=normalized_url,
                    title=title,
                    owner=owner,
                    duration_s=probe.duration_s or page.duration_s,
                    subtitle_tracks=subtitle_tracks,
                ),
            )
            return BilibiliImportResult(
                absolute_path=destination,
                relative_source_path=to_relative_audio_path(destination) or relative_path.as_posix(),
                media_type="video" if download_target == "video" else "audio",
                title=title,
                owner=owner,
                duration_s=probe.duration_s or page.duration_s,
                download_target=download_target,
            )
        except DomainError as exc:
            last_error = exc
            if exc.code != "bilibili_unavailable":
                raise

    assert last_error is not None
    raise last_error


def import_bilibili_media_via_subprocess(
    url: str,
    *,
    download_target: BilibiliDownloadTarget,
) -> BilibiliImportResult:
    repo_root = _repo_root()
    entry_script = repo_root / "server" / "scripts" / "bilibili_import_entry.py"
    env = _build_bilibili_subprocess_env(repo_root)
    completed = subprocess.run(
        [sys.executable, str(entry_script), url, download_target],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        env=env,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()[:400]
        raise DomainError("bilibili_unavailable", detail or "B 站导入子进程执行失败")

    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise DomainError("bilibili_unavailable", "B 站导入子进程返回了无效 JSON") from exc

    return BilibiliImportResult(
        absolute_path=Path(payload["absolute_path"]),
        relative_source_path=str(payload["relative_source_path"]),
        media_type=str(payload["media_type"]),
        title=str(payload["title"]),
        owner=(str(payload["owner"]) if payload.get("owner") else None),
        duration_s=float(payload["duration_s"]),
        download_target=str(payload["download_target"]),
    )
