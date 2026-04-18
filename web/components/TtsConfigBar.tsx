"use client";

import { useCallback, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MediaCloneDialog } from "./MediaCloneDialog";
import { TtsPresetDialog } from "./TtsPresetDialog";

interface Props {
  episodeId: string;
  config: Record<string, unknown>;
  onConfigSaved?: () => void;
  onUpdateConfig: (epId: string, config: Record<string, unknown>) => Promise<void>;
}

interface FormState {
  cfg_value: string;
  inference_timesteps: string;
  control_prompt: string;
  reference_audio_path: string;
  prompt_audio_path: string;
  prompt_text: string;
  normalize: boolean;
  denoise: boolean;
}

type TtsMode = "voice_design" | "controllable_cloning" | "ultimate_cloning";

const DEFAULTS: FormState = {
  cfg_value: "2.0",
  inference_timesteps: "10",
  control_prompt: "",
  reference_audio_path: "",
  prompt_audio_path: "",
  prompt_text: "",
  normalize: false,
  denoise: false,
};

const MODE_META: Record<
  TtsMode,
  { label: string; title: string; description: string }
> = {
  voice_design: {
    label: "Voice Design",
    title: "声音设计",
    description: "不用参考音频，只靠 Control Prompt 从零设计一个声音。",
  },
  controllable_cloning: {
    label: "Controllable Cloning",
    title: "可控克隆",
    description: "提供参考音频保留音色，同时还能用 Control Prompt 调语气和风格。",
  },
  ultimate_cloning: {
    label: "Ultimate Cloning",
    title: "极致克隆",
    description: "提供 Prompt Audio 和对应文本做续写，高保真复现原音频细节。",
  },
};

function configToForm(config: Record<string, unknown>): FormState {
  return {
    cfg_value: String(config.cfg_value ?? DEFAULTS.cfg_value),
    inference_timesteps: String(
      config.inference_timesteps ?? DEFAULTS.inference_timesteps,
    ),
    control_prompt: String(config.control_prompt ?? DEFAULTS.control_prompt),
    reference_audio_path: String(
      config.reference_audio_path ?? DEFAULTS.reference_audio_path,
    ),
    prompt_audio_path: String(
      config.prompt_audio_path ?? DEFAULTS.prompt_audio_path,
    ),
    prompt_text: String(config.prompt_text ?? DEFAULTS.prompt_text),
    normalize: Boolean(config.normalize ?? DEFAULTS.normalize),
    denoise: Boolean(config.denoise ?? DEFAULTS.denoise),
  };
}

function inferMode(config: Record<string, unknown>): TtsMode {
  const promptAudioPath = String(config.prompt_audio_path ?? "").trim();
  const promptText = String(config.prompt_text ?? "").trim();
  const referenceAudioPath = String(config.reference_audio_path ?? "").trim();

  if (promptAudioPath || promptText) return "ultimate_cloning";
  if (referenceAudioPath) return "controllable_cloning";
  return "voice_design";
}

function formToConfig(form: FormState, mode: TtsMode): Record<string, unknown> {
  const base: Record<string, unknown> = {
    cfg_value: parseFloat(form.cfg_value) || 2.0,
    inference_timesteps: parseInt(form.inference_timesteps, 10) || 10,
    normalize: form.normalize,
  };

  if (mode === "voice_design") {
    return {
      ...base,
      control_prompt: form.control_prompt || undefined,
      denoise: false,
    };
  }

  if (mode === "controllable_cloning") {
    return {
      ...base,
      control_prompt: form.control_prompt || undefined,
      reference_audio_path: form.reference_audio_path || undefined,
      denoise: form.denoise,
    };
  }

  return {
    ...base,
    prompt_audio_path: form.prompt_audio_path || undefined,
    prompt_text: form.prompt_text || undefined,
    denoise: form.denoise,
  };
}

function HelpTip({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-neutral-300 text-[9px] font-bold text-neutral-400 hover:border-neutral-600 hover:text-neutral-600">
            ?
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ModeCard({
  mode,
  active,
  onSelect,
}: {
  mode: TtsMode;
  active: boolean;
  onSelect: (mode: TtsMode) => void;
}) {
  const meta = MODE_META[mode];

  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      className={`rounded-lg border px-3 py-3 text-left transition ${
        active
          ? "border-blue-500 bg-blue-50 shadow-sm dark:border-blue-400 dark:bg-blue-950/30"
          : "border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {meta.title}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-mono ${
            active
              ? "bg-blue-600 text-white dark:bg-blue-500"
              : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
          }`}
        >
          {meta.label}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
        {meta.description}
      </p>
    </button>
  );
}

export function TtsConfigBar({
  episodeId,
  config,
  onConfigSaved,
  onUpdateConfig,
}: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mediaDialogOpen, setMediaDialogOpen] = useState(false);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [savedHint, setSavedHint] = useState(false);

  const hasOverride = Object.keys(config).length > 0;
  const mode = inferMode(config);

  const field = (key: string, value: string) => (
    <span className="inline-flex items-center gap-1">
      <span className="text-neutral-400 dark:text-neutral-500">{key}=</span>
      <span
        className={`font-mono ${
          hasOverride
            ? "text-blue-600 dark:text-blue-400"
            : "text-neutral-600 dark:text-neutral-400"
        }`}
      >
        {value}
      </span>
    </span>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-4 border-b border-neutral-200 bg-neutral-50 px-6 py-1.5 text-[11px] dark:border-neutral-700 dark:bg-neutral-800">
        <span className="shrink-0 font-semibold text-neutral-500 dark:text-neutral-400">
          TTS 配置：
        </span>
        {field("mode", MODE_META[mode].title)}
        {field("cfg", String(config.cfg_value ?? "2.0"))}
        {field("steps", String(config.inference_timesteps ?? "10"))}
        {mode !== "ultimate_cloning"
          ? field("control", String(config.control_prompt || "未设置"))
          : null}
        {mode === "controllable_cloning"
          ? field("reference", String(config.reference_audio_path || "未设置"))
          : null}
        {mode === "ultimate_cloning"
          ? field("prompt", String(config.prompt_audio_path || "未设置"))
          : null}
        {mode !== "voice_design"
          ? field("denoise", Boolean(config.denoise ?? false) ? "on" : "off")
          : null}
        <button
          type="button"
          onClick={() => setMediaDialogOpen(true)}
          className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600 hover:border-neutral-400 hover:bg-white dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:bg-neutral-700"
          title="从 mp4 或音频片段生成克隆素材"
        >
          素材处理
        </button>
        <button
          type="button"
          onClick={() => setPresetDialogOpen(true)}
          className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600 hover:border-neutral-400 hover:bg-white dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:bg-neutral-700"
          title="打开 TTS 预设库"
        >
          预设
        </button>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="ml-auto rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600 hover:border-neutral-400 hover:bg-white dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:bg-neutral-700"
          title="编辑 TTS 配置"
        >
          编辑
        </button>
        {hasOverride ? (
          <span className="font-mono text-[10px] text-blue-600 dark:text-blue-400">
            已覆盖默认值
          </span>
        ) : null}
      </div>

      {savedHint ? (
        <div className="flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-6 py-1 text-[11px] text-emerald-800">
          <span>配置已保存</span>
          <span className="text-emerald-700">
            重新运行 P2 后，新配置才会应用到新的 take。
          </span>
        </div>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <ConfigForm
            episodeId={episodeId}
            config={config}
            onClose={() => setDialogOpen(false)}
            onSaved={() => {
              setDialogOpen(false);
              setSavedHint(true);
              onConfigSaved?.();
              setTimeout(() => setSavedHint(false), 6000);
            }}
            onUpdateConfig={onUpdateConfig}
          />
        </DialogContent>
      </Dialog>

      <TtsPresetDialog
        open={presetDialogOpen}
        onClose={() => setPresetDialogOpen(false)}
        currentConfig={config}
        onApplyPreset={async (nextConfig) => {
          await onUpdateConfig(episodeId, nextConfig);
          onConfigSaved?.();
          setSavedHint(true);
          setTimeout(() => setSavedHint(false), 6000);
        }}
      />

      <MediaCloneDialog
        open={mediaDialogOpen}
        onClose={() => setMediaDialogOpen(false)}
        currentConfig={config}
        onApplyConfig={async (nextConfig) => {
          await onUpdateConfig(episodeId, nextConfig);
          onConfigSaved?.();
          setSavedHint(true);
          setTimeout(() => setSavedHint(false), 6000);
        }}
        onApplied={() => {
          onConfigSaved?.();
          setSavedHint(true);
          setTimeout(() => setSavedHint(false), 6000);
        }}
      />
    </>
  );
}

function ConfigForm({
  episodeId,
  config,
  onClose,
  onSaved,
  onUpdateConfig,
}: {
  episodeId: string;
  config: Record<string, unknown>;
  onClose: () => void;
  onSaved: () => void;
  onUpdateConfig: (epId: string, config: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState<FormState>(configToForm(config));
  const [mode, setMode] = useState<TtsMode>(() => inferMode(config));
  const [saving, setSaving] = useState(false);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onUpdateConfig(episodeId, formToConfig(form, mode));
      onSaved();
    } catch (e) {
      toast.error("保存失败", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [episodeId, form, mode, onSaved, onUpdateConfig]);

  const inputClass =
    "w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100";

  const showControlPrompt = mode !== "ultimate_cloning";
  const showReferenceAudio = mode === "controllable_cloning";
  const showPromptAudio = mode === "ultimate_cloning";
  const showDenoise = mode !== "voice_design";

  return (
    <>
      <DialogHeader>
        <DialogTitle>VoxCPM TTS 配置</DialogTitle>
        <DialogDescription>
          这里控制本地 VoxCPM 的合成行为。P2 会调用本地{" "}
          <code>voxcpm-svc</code>，P2v 会调用本地 WhisperX。
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 px-5 py-4 text-sm">
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            模式选择
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {(Object.keys(MODE_META) as TtsMode[]).map((value) => (
              <ModeCard
                key={value}
                mode={value}
                active={mode === value}
                onSelect={setMode}
              />
            ))}
          </div>
          <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs leading-relaxed text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            当前模式：
            <span className="ml-1 font-semibold text-neutral-900 dark:text-neutral-100">
              {MODE_META[mode].title}
            </span>
            <span className="ml-2">{MODE_META[mode].description}</span>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
              CFG Value
              <HelpTip>指导强度。通常 1.5 到 3.0 之间比较稳，越高越强调提示条件。</HelpTip>
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={form.cfg_value}
              onChange={(e) => setField("cfg_value", e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
              Inference Timesteps
              <HelpTip>扩散步数。更高通常更稳但更慢，常用 5 到 12。</HelpTip>
            </label>
            <input
              type="number"
              step="1"
              min="1"
              value={form.inference_timesteps}
              onChange={(e) => setField("inference_timesteps", e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        {showControlPrompt ? (
          <div>
            <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
              Control Prompt
              <HelpTip>
                用来描述年龄、语气、情绪、语速等风格。当前项目会自动拼成
                <code>(control prompt)正文</code>。
              </HelpTip>
            </label>
            <input
              type="text"
              value={form.control_prompt}
              onChange={(e) => setField("control_prompt", e.target.value)}
              className={inputClass}
              placeholder="例如：young female voice, warm and gentle, slightly faster"
            />
          </div>
        ) : (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            极致克隆模式下建议留空 Control Prompt，只提供 Prompt Audio 和
            Prompt Text，让模型按前文续写。
          </div>
        )}

        {showReferenceAudio ? (
          <div>
            <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
              Reference Audio Path
              <HelpTip>
                决定“像谁说”。现在统一填写相对于 <code>voice_sourse</code> 的路径，
                例如 <code>111.m4a</code> 或 <code>主播A/开场.wav</code>。
              </HelpTip>
            </label>
            <input
              type="text"
              value={form.reference_audio_path}
              onChange={(e) => setField("reference_audio_path", e.target.value)}
              className={inputClass}
              placeholder="例如：111.m4a"
            />
          </div>
        ) : null}

        {showPromptAudio ? (
          <>
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
                Prompt Audio Path
                <HelpTip>
                  决定“从哪句继续说”。这里也填写相对于 <code>voice_sourse</code> 的路径。
                </HelpTip>
              </label>
              <input
                type="text"
                value={form.prompt_audio_path}
                onChange={(e) => setField("prompt_audio_path", e.target.value)}
                className={inputClass}
                placeholder="例如：111.m4a"
              />
            </div>

            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
                Prompt Text
                <HelpTip>
                  填写 Prompt Audio 里真实说出的文本。当前 harness 不会自动识别这段前文，最好手填。
                </HelpTip>
              </label>
              <textarea
                value={form.prompt_text}
                onChange={(e) => setField("prompt_text", e.target.value)}
                className={`${inputClass} min-h-20 resize-y`}
                placeholder="填写 prompt 音频中真实朗读的文本"
              />
            </div>
          </>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-center gap-2 rounded border border-neutral-200 px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={form.normalize}
              onChange={(e) => setField("normalize", e.target.checked)}
            />
            文本标准化
          </label>
          {showDenoise ? (
            <label className="flex items-center gap-2 rounded border border-neutral-200 px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={form.denoise}
                onChange={(e) => setField("denoise", e.target.checked)}
              />
              参考音频降噪
            </label>
          ) : (
            <div className="rounded border border-dashed border-neutral-200 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
              声音设计模式不使用参考音频，因此不会启用降噪。
            </div>
          )}
        </div>
      </div>

      <DialogFooter>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className={`ml-auto rounded px-4 py-1.5 text-xs ${
            saving
              ? "bg-neutral-200 text-neutral-400 dark:bg-neutral-700"
              : "bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          }`}
        >
          {saving ? "保存中..." : "保存配置"}
        </button>
      </DialogFooter>
    </>
  );
}
