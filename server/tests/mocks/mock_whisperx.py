"""Mock WhisperX — 按 (chunk_id, attempt) 返回预设 transcript"""


class MockWhisperX:
    def __init__(self, fixtures: dict[str, list[dict]]):
        """fixtures: {chunk_id: [attempt1_transcript, attempt2_transcript, ...]}"""
        self.fixtures = fixtures
        self.call_count: dict[str, int] = {}

    async def transcribe(self, chunk_id: str, audio_path: str) -> dict:
        count = self.call_count.get(chunk_id, 0)
        self.call_count[chunk_id] = count + 1
        transcripts = self.fixtures.get(chunk_id, [])
        if count < len(transcripts):
            return transcripts[count]
        return transcripts[-1] if transcripts else {"segments": [], "full_transcribed_text": ""}
