from __future__ import annotations

import json
import sys

from server.core.bilibili_import import import_bilibili_media


def main() -> int:
    if len(sys.argv) != 3:
        print(
            json.dumps(
                {"error": "usage", "detail": "usage: bilibili_import_entry.py <url> <video|audio>"},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    url = sys.argv[1]
    download_target = sys.argv[2]
    result = import_bilibili_media(url, download_target=download_target)  # type: ignore[arg-type]
    print(
        json.dumps(
            {
                "absolute_path": str(result.absolute_path),
                "relative_source_path": result.relative_source_path,
                "media_type": result.media_type,
                "title": result.title,
                "owner": result.owner,
                "duration_s": result.duration_s,
                "download_target": result.download_target,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
