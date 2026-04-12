"""Mock TTS Provider — 按 (chunk_id, attempt) 返回预设 WAV"""


class MockTTSProvider:
    def __init__(self, fixtures: dict[str, list[bytes]]):
        """fixtures: {chunk_id: [attempt1_wav_bytes, attempt2_wav_bytes, ...]}"""
        self.fixtures = fixtures
        self.call_count: dict[str, int] = {}

    async def synthesize(self, chunk_id: str, text: str, params: dict) -> bytes:
        count = self.call_count.get(chunk_id, 0)
        self.call_count[chunk_id] = count + 1
        wavs = self.fixtures.get(chunk_id, [])
        if count < len(wavs):
            return wavs[count]
        return wavs[-1] if wavs else b""
