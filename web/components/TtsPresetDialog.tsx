"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/hooks/useConfirm";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { normalizeImportedPresetPayload, sanitizeTtsConfig, useTtsPresets } from "@/lib/tts-presets";
import type { PresetScope, TtsPreset } from "@/lib/tts-presets";

interface Props {
  open: boolean;
  onClose: () => void;
  currentConfig: Record<string, unknown>;
  onApplyPreset: (config: Record<string, unknown>) => Promise<void>;
}

function scopeLabel(scope: PresetScope): string {
  return scope === "project" ? "项目" : "全局";
}

function describeImportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/reference_audio_path|prompt_audio_path|prompt_text/.test(message)) {
    return `${message}。如果这是从别的机器导出的预设，请先把里面的本地音频路径改成当前机器可用的绝对路径。`;
  }
  return message;
}

export function TtsPresetDialog({ open, onClose, currentConfig, onApplyPreset }: Props) {
  const {
    projectPresets,
    globalPresets,
    projectPath,
    globalPath,
    savePreset,
    updatePreset,
    deletePreset,
    setDefaultPreset,
    importPresets,
    exportPresets,
  } = useTtsPresets();
  const [confirmAction, ConfirmDialog] = useConfirm();
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetScope, setNewPresetScope] = useState<PresetScope>("project");
  const importInputRef = useRef<HTMLInputElement>(null);
  const currentSnapshot = useMemo(() => sanitizeTtsConfig(currentConfig), [currentConfig]);

  const handleSaveNew = async () => {
    if (!newPresetName.trim()) {
      toast.error("请先填写预设名称");
      return;
    }
    await savePreset(
      newPresetScope,
      newPresetName,
      currentSnapshot,
      newPresetScope === "project" ? projectPresets.length === 0 : globalPresets.length === 0,
    );
    setNewPresetName("");
    toast.success(`已保存到${scopeLabel(newPresetScope)}预设`);
  };

  const handleExport = async (scope: PresetScope) => {
    const payload = await exportPresets(scope);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tts-presets.${scope}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(`已导出${scopeLabel(scope)}预设`);
  };

  const handleImportPick = (scope: PresetScope) => {
    importInputRef.current?.setAttribute("data-scope", scope);
    importInputRef.current?.click();
  };

  const handleOverwritePreset = async (scope: PresetScope, preset: TtsPreset) => {
    const accepted = await confirmAction("确认覆盖这个预设吗？", {
      description: `会用当前 Episode 的 TTS 配置覆盖“${preset.name}”，原预设内容将被改写。`,
      confirmLabel: "确认覆盖",
    });
    if (!accepted) return;

    await updatePreset(scope, preset.id, { config: currentSnapshot });
    toast.success(`已用当前配置覆盖“${preset.name}”`);
  };

  const handleDeletePreset = async (scope: PresetScope, preset: TtsPreset) => {
    const accepted = await confirmAction("确认删除这个预设吗？", {
      description: `删除“${preset.name}”后无法恢复。`,
      confirmLabel: "确认删除",
      destructive: true,
    });
    if (!accepted) return;

    await deletePreset(scope, preset.id);
    toast.success(`已删除“${preset.name}”`);
  };

  const renderScopeSection = (scope: PresetScope, presets: TtsPreset[], pathHint: string) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{scopeLabel(scope)}预设</div>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400">{pathHint}</div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleImportPick(scope)}
            className="rounded border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            导入
          </button>
          <button
            type="button"
            onClick={() => handleExport(scope)}
            className="rounded border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            导出
          </button>
        </div>
      </div>

      {presets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-4 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          这一层还没有预设。
        </div>
      ) : (
        <div className="max-h-[240px] space-y-2 overflow-y-auto pr-1">
          {presets.map((preset) => (
            <div key={preset.id} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{preset.name}</div>
                {preset.isDefault ? (
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                    默认
                  </span>
                ) : null}
                <span className="ml-auto font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
                  {new Date(preset.updatedAt).toLocaleString()}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-neutral-600 dark:text-neutral-300">
                {Object.entries(preset.config).length > 0 ? (
                  Object.entries(preset.config).map(([key, value]) => (
                    <span key={key} className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                      {key}={typeof value === "boolean" ? (value ? "on" : "off") : String(value)}
                    </span>
                  ))
                ) : (
                  <span className="text-neutral-400">空配置</span>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await onApplyPreset(preset.config);
                    toast.success(`已把“${preset.name}”套用到当前 Episode`);
                  }}
                  className="rounded bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
                >
                  套用到当前 Episode
                </button>
                <button
                  type="button"
                  onClick={() => handleOverwritePreset(scope, preset)}
                  className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  用当前配置覆盖
                </button>
                {!preset.isDefault ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await setDefaultPreset(scope, preset.id);
                      toast.success(`已把“${preset.name}”设为${scopeLabel(scope)}默认预设`);
                    }}
                    className="rounded border border-blue-300 px-3 py-1 text-xs text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-950/30"
                  >
                    设为默认
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => handleDeletePreset(scope, preset)}
                  className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950/30"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>TTS 预设库</DialogTitle>
            <DialogDescription>
              这里保存可复用的 VoxCPM 配置。项目预设跟仓库走，全局预设跟机器走；新建 Episode
              时可以直接套用默认预设。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-5 py-4">
            <div className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
              <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">把当前配置另存为新预设</div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPresetName}
                  onChange={(event) => setNewPresetName(event.target.value)}
                  placeholder="例如：女声知识口播"
                  className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                />
                <select
                  value={newPresetScope}
                  onChange={(event) => setNewPresetScope(event.target.value as PresetScope)}
                  className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                >
                  <option value="project">项目预设</option>
                  <option value="global">全局预设</option>
                </select>
                <button
                  type="button"
                  onClick={handleSaveNew}
                  className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
                >
                  保存
                </button>
              </div>
            </div>

            {renderScopeSection("project", projectPresets, projectPath)}
            {renderScopeSection("global", globalPresets, globalPath)}
          </div>

          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={async (event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              const scope = (input.getAttribute("data-scope") as PresetScope | null) ?? "project";
              if (!file) return;
              try {
                const text = (await file.text()).replace(/^\uFEFF/, "");
                const payload = normalizeImportedPresetPayload(JSON.parse(text));
                await importPresets(scope, payload, false);
                toast.success(`已导入到${scopeLabel(scope)}预设`);
              } catch (error) {
                toast.error("导入预设失败", {
                  description: describeImportError(error),
                });
              } finally {
                input.value = "";
              }
            }}
          />

          <DialogFooter>
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              关闭
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {ConfirmDialog}
    </>
  );
}
