export type TtsMode = "voice_design" | "controllable_cloning" | "ultimate_cloning";

export const CHUNK_CONTROL_PROMPT_OVERRIDE_KEY = "tts_control_prompt_override";

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function inferTtsMode(config: Record<string, unknown> | undefined): TtsMode {
  const source = config ?? {};
  const explicitMode = getString(source.tts_mode);
  if (
    explicitMode === "voice_design"
    || explicitMode === "controllable_cloning"
    || explicitMode === "ultimate_cloning"
  ) {
    return explicitMode;
  }
  const promptAudioPath = getString(source.prompt_audio_path);
  const promptText = getString(source.prompt_text);
  const referenceAudioPath = getString(source.reference_audio_path);

  if (promptAudioPath || promptText) return "ultimate_cloning";
  if (referenceAudioPath) return "controllable_cloning";
  return "voice_design";
}

export function getChunkControlPromptOverride(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata || !(CHUNK_CONTROL_PROMPT_OVERRIDE_KEY in metadata)) {
    return undefined;
  }
  const value = metadata[CHUNK_CONTROL_PROMPT_OVERRIDE_KEY];
  return typeof value === "string" ? value : "";
}

export function hasChunkControlPromptOverride(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return Boolean(metadata) && CHUNK_CONTROL_PROMPT_OVERRIDE_KEY in metadata!;
}

export function getEpisodeControlPrompt(config: Record<string, unknown> | undefined): string {
  return getString(config?.control_prompt);
}

export function getEffectiveChunkControlPrompt(
  config: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): string {
  const override = getChunkControlPromptOverride(metadata);
  if (override !== undefined) return override;
  return getEpisodeControlPrompt(config);
}

export function getTtsModeLabel(mode: TtsMode): string {
  if (mode === "controllable_cloning") return "可控克隆";
  if (mode === "ultimate_cloning") return "极致克隆";
  return "声音设计";
}
