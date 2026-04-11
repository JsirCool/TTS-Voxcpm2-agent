"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { updateConfig } from "@/lib/hooks";

// ---------------------------------------------------------------------------
// HelpIcon (from original)
// ---------------------------------------------------------------------------

function HelpIcon({ children, placement = "right" }: { children: ReactNode; placement?: "left" | "right" }) {
  const tipPos = placement === "right" ? "left-5 top-0" : "right-5 top-0";
  return (
    <span className="relative inline-flex group cursor-help">
      <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-neutral-300 text-neutral-400 text-[9px] font-bold leading-none hover:border-neutral-600 hover:text-neutral-600" aria-label="说明">?</span>
      <span role="tooltip" className={`pointer-events-none absolute ${tipPos} z-50 w-64 opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-150 bg-neutral-900 text-white text-[11px] leading-relaxed rounded-md shadow-lg px-3 py-2`}>{children}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  episodeId: string;
  config: Record<string, unknown>;
  onConfigSaved?: () => void;
}

interface FormState {
  model: string;
  temperature: string;
  top_p: string;
  speed: string;
  reference_id: string;
}

const DEFAULTS: FormState = {
  model: "s2-pro",
  temperature: "0.7",
  top_p: "0.7",
  speed: "1.15",
  reference_id: "",
};

function configToForm(config: Record<string, unknown>): FormState {
  return {
    model: String(config.model ?? DEFAULTS.model),
    temperature: String(config.temperature ?? DEFAULTS.temperature),
    top_p: String(config.top_p ?? DEFAULTS.top_p),
    speed: String(config.speed ?? DEFAULTS.speed),
    reference_id: String(config.reference_id ?? DEFAULTS.reference_id),
  };
}

function formToConfig(form: FormState): Record<string, unknown> {
  return {
    model: form.model,
    temperature: parseFloat(form.temperature) || 0.7,
    top_p: parseFloat(form.top_p) || 0.7,
    speed: parseFloat(form.speed) || 1.15,
    reference_id: form.reference_id || undefined,
  };
}

// ---------------------------------------------------------------------------
// Config Bar (top-level: one-line summary + edit button)
// ---------------------------------------------------------------------------

export function TtsConfigBar({ episodeId, config, onConfigSaved }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [savedHint, setSavedHint] = useState(false);

  const hasOverride = Object.keys(config).length > 0;

  const field = (key: string, value: string) => (
    <span className="inline-flex items-center gap-1">
      <span className="text-neutral-400">{key}=</span>
      <span className={`font-mono ${hasOverride ? "text-blue-600" : "text-neutral-600"}`}>{value}</span>
    </span>
  );

  return (
    <>
      <div className="px-6 py-1.5 border-b border-neutral-200 bg-neutral-50 text-[11px] flex items-center gap-4 flex-wrap">
        <span className="text-neutral-500 font-semibold shrink-0">TTS Config:</span>
        {field("model", String(config.model ?? "s2-pro"))}
        {field("temperature", String(config.temperature ?? "0.7"))}
        {field("top_p", String(config.top_p ?? "0.7"))}
        {field("speed", `${config.speed ?? 1.15}x`)}
        {field("reference_id", String(config.reference_id || "(none)"))}
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="ml-auto px-2 py-0.5 text-[11px] rounded border border-neutral-300 text-neutral-600 hover:bg-white hover:border-neutral-400"
          title="编辑 TTS 配置"
        >
          ✎ 编辑
        </button>
        {hasOverride && (
          <span className="text-[10px] text-blue-600 font-mono" title="此 episode 有自定义配置">● override</span>
        )}
      </div>
      {savedHint && (
        <div className="px-6 py-1 border-b border-emerald-200 bg-emerald-50 text-[11px] text-emerald-800 flex items-center gap-2">
          <span>✓ 已保存</span>
          <span className="text-emerald-700">· 点 chunk 的 P2 pill → 仅重跑 P2 验证新配置</span>
        </div>
      )}
      {dialogOpen && (
        <TtsConfigDialog
          episodeId={episodeId}
          config={config}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false);
            setSavedHint(true);
            onConfigSaved?.();
            setTimeout(() => setSavedHint(false), 6000);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Config Dialog (edit form in overlay)
// ---------------------------------------------------------------------------

function TtsConfigDialog({
  episodeId,
  config,
  onClose,
  onSaved,
}: {
  episodeId: string;
  config: Record<string, unknown>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(configToForm(config));
  const [saving, setSaving] = useState(false);

  const set = (key: keyof FormState, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateConfig(episodeId, formToConfig(form));
      onSaved();
    } catch (e) {
      alert(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [episodeId, form, onSaved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const inputClass = "w-full px-2 py-1.5 text-xs border border-neutral-300 rounded font-mono focus:outline-none focus:ring-1 focus:ring-blue-400";

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-md flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-neutral-200">
          <h2 className="font-semibold text-sm">编辑 TTS 配置</h2>
          <p className="text-[11px] text-neutral-500 mt-0.5 leading-relaxed">
            调试工作流: <strong className="text-neutral-700">改配置 → 单 chunk retry 试听 → 满意后批量合成</strong>。
          </p>
        </div>

        <div className="px-5 py-4 space-y-3 text-sm">
          {/* Model */}
          <div>
            <label className="text-xs text-neutral-600 flex items-center gap-1 mb-1">
              Model
              <HelpIcon>Fish Audio 的模型版本。当前支持 s2-pro（推荐）和 s2。</HelpIcon>
            </label>
            <select value={form.model} onChange={(e) => set("model", e.target.value)} className={inputClass}>
              <option value="s2-pro">s2-pro</option>
              <option value="s2">s2</option>
            </select>
          </div>

          {/* Temperature */}
          <div>
            <label className="text-xs text-neutral-600 flex items-center gap-1 mb-1">
              Temperature
              <HelpIcon>控制随机性。0 = 最确定性，1 = 最随机。推荐 0.5-0.8。值越低发音越稳定但可能偏机械。</HelpIcon>
            </label>
            <input type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={(e) => set("temperature", e.target.value)} className={inputClass} />
          </div>

          {/* Top P */}
          <div>
            <label className="text-xs text-neutral-600 flex items-center gap-1 mb-1">
              Top P
              <HelpIcon>核采样参数。与 temperature 配合使用。推荐 0.5-0.8。</HelpIcon>
            </label>
            <input type="number" step="0.1" min="0" max="1" value={form.top_p} onChange={(e) => set("top_p", e.target.value)} className={inputClass} />
          </div>

          {/* Speed */}
          <div>
            <label className="text-xs text-neutral-600 flex items-center gap-1 mb-1">
              Speed
              <HelpIcon>语速倍率。1.0 = 正常速度，1.15 = 略快。范围 0.5-2.0。</HelpIcon>
            </label>
            <input type="number" step="0.05" min="0.5" max="2" value={form.speed} onChange={(e) => set("speed", e.target.value)} className={inputClass} />
          </div>

          {/* Reference ID */}
          <div>
            <label className="text-xs text-neutral-600 flex items-center gap-1 mb-1">
              Reference ID
              <HelpIcon placement="left">Fish Audio 声音克隆 ID。留空则用默认声音。在 Fish Audio 平台创建并获取 ID。</HelpIcon>
            </label>
            <input type="text" value={form.reference_id} onChange={(e) => set("reference_id", e.target.value)} className={inputClass} placeholder="留空使用默认声音" />
          </div>
        </div>

        <div className="border-t border-neutral-200 px-5 py-3 flex items-center gap-3">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 rounded">取消</button>
          <button type="button" onClick={handleSave} disabled={saving} className={`ml-auto px-4 py-1.5 text-xs rounded ${saving ? "bg-neutral-200 text-neutral-400" : "bg-neutral-900 text-white hover:bg-neutral-800"}`}>
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>
      </div>
    </div>
  );
}
