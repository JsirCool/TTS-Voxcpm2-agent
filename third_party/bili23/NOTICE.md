This directory contains a minimal, adapted subset of logic derived from:

- Project: Bili23 Downloader
- Repository: https://github.com/ScottSloan/Bili23-Downloader
- Upstream commit: `11bc6e6de2ca2c9eb9eee4ed8b82a235dfe285a9`
- License: GPL-3.0

Only the small helper subset required by the harness is included here.
The original project contains a much larger GUI application and download stack.

Adapted pieces currently used by this repository:

- AV -> BV conversion
- WBI signing helper

Integration points inside this repository:

- `E:\VC\tts-agent-harness\third_party\bili23\helpers.py`
- `E:\VC\tts-agent-harness\server\core\bilibili_import.py`
