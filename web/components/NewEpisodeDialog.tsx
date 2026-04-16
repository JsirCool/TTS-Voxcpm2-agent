"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { sanitizeTtsConfig, useTtsPresets } from "@/lib/tts-presets";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (id: string, file: File, options?: { title?: string; config?: Record<string, unknown> }) => void | Promise<void>;
}

export function NewEpisodeDialog({ open, onClose, onCreate }: Props) {
  const [id, setId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [inputMode, setInputMode] = useState<"json" | "text">("json");
  const { presets, defaultPreset } = useTtsPresets();
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setId("");
    setFile(null);
    setTitle("");
    setRawText("");
    setInputMode("json");
    setDragging(false);
    setSelectedPresetId("");
  }, [open]);

  useEffect(() => {
    if (!open || selectedPresetId) return;
    setSelectedPresetId(defaultPreset?.id ?? "");
  }, [defaultPreset, open, selectedPresetId]);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId],
  );

  const textSegments = useMemo(() => {
    const blocks = rawText
      .split(/\r?\n\s*\r?\n/g)
      .map((block) => block.trim())
      .filter(Boolean);
    const source = blocks.length > 0
      ? blocks
      : rawText.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
    return source.map((block, index) => {
      const match = block.match(/^(hook|content|cta|intro|outro)\s*[:：]\s*(.+)$/i);
      if (match) {
        return {
          id: index + 1,
          type: match[1].toLowerCase(),
          text: match[2].trim(),
        };
      }
      return {
        id: index + 1,
        text: block,
      };
    });
  }, [rawText]);

  const handleCreate = async () => {
    if (!id.trim()) return;
    const nextConfig = selectedPreset ? sanitizeTtsConfig(selectedPreset.config) : undefined;
    let payloadFile = file;
    if (inputMode === "text") {
      if (textSegments.length === 0) return;
      const script = {
        title: title.trim() || id.trim(),
        segments: textSegments,
      };
      payloadFile = new File(
        [JSON.stringify(script, null, 2)],
        `${id.trim()}.json`,
        { type: "application/json" },
      );
    }
    if (!payloadFile) return;

    setSubmitting(true);
    try {
      await onCreate(id.trim(), payloadFile, {
        title: title.trim() || undefined,
        config: nextConfig,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped && dropped.name.endsWith(".json")) {
      setFile(dropped);
      if (!id.trim()) {
        setId(dropped.name.replace(/\.json$/, ""));
      }
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900 w-[36rem] max-w-[calc(100vw-2rem)] p-5 max-h-[90vh] overflow-y-auto">
        <h2 className="font-semibold mb-4">新建 Episode</h2>

        <div className="mb-4 inline-flex rounded border border-neutral-300 dark:border-neutral-600 overflow-hidden text-sm">
          <button
            type="button"
            onClick={() => setInputMode("json")}
            className={`px-3 py-1.5 ${
              inputMode === "json"
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "bg-white text-neutral-600 hover:bg-neutral-100 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            }`}
          >
            导入 JSON
          </button>
          <button
            type="button"
            onClick={() => setInputMode("text")}
            className={`px-3 py-1.5 border-l border-neutral-300 dark:border-neutral-600 ${
              inputMode === "text"
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "bg-white text-neutral-600 hover:bg-neutral-100 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            }`}
          >
            直接输入文本
          </button>
        </div>

        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Episode ID</label>
        <input
          type="text"
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="ch06"
          className="w-full border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1.5 text-sm mb-3 bg-white dark:bg-neutral-800 dark:text-neutral-100 focus:outline-none focus:border-neutral-900 dark:focus:border-neutral-400"
        />

        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">脚本标题</label>
        <input
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="默认会跟 Episode ID 一样"
          className="w-full border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1.5 text-sm mb-3 bg-white dark:bg-neutral-800 dark:text-neutral-100 focus:outline-none focus:border-neutral-900 dark:focus:border-neutral-400"
        />

        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">TTS 预设</label>
        <select
          value={selectedPresetId}
          onChange={(event) => setSelectedPresetId(event.target.value)}
          className="w-full border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1.5 text-sm mb-3 bg-white dark:bg-neutral-800 dark:text-neutral-100"
        >
          <option value="">不套用预设</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              [{preset.scope === "project" ? "项目" : "全局"}] {preset.name}{preset.isDefault ? "（默认）" : ""}
            </option>
          ))}
        </select>

        {selectedPreset ? (
          <div className="mb-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] leading-relaxed text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
            创建时会自动套用预设“{selectedPreset.name}”，不用再进入 Episode 后重复配置。
          </div>
        ) : null}

        {inputMode === "json" ? (
          <>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">脚本文件</label>
            <p className="mb-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              导入 `script.json`，或者切到“直接输入文本”，系统会在内部帮你转成 JSON。
            </p>
            <div
              onDrop={handleDrop}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                setDragging(false);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={[
                "w-full border-2 border-dashed rounded-lg px-4 py-6 mb-4 cursor-pointer transition-colors text-center",
                dragging
                  ? "border-blue-400 bg-blue-50 dark:bg-blue-900/20"
                  : file
                    ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-900/20"
                    : "border-neutral-300 dark:border-neutral-600 hover:border-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800",
              ].join(" ")}
            >
              {file ? (
                <div>
                  <div className="text-sm font-medium text-emerald-700">{file.name}</div>
                  <div className="text-[10px] text-neutral-500 mt-1">
                    {(file.size / 1024).toFixed(1)} KB
                    <span className="ml-2 text-neutral-400">点击替换文件</span>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-sm text-neutral-500">把 .json 文件拖到这里</div>
                  <div className="text-[10px] text-neutral-400 mt-1">或点击选择文件</div>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={(event) => {
                  const nextFile = event.target.files?.[0] ?? null;
                  setFile(nextFile);
                  if (nextFile && !id.trim()) {
                    setId(nextFile.name.replace(/\.json$/, ""));
                  }
                }}
                className="hidden"
              />
            </div>
          </>
        ) : (
          <>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">口播文本</label>
            <textarea
              value={rawText}
              onChange={(event) => setRawText(event.target.value)}
              placeholder={"直接粘贴文稿。\n\n空行会自动切成一个 segment。\n也支持 hook: / content: / cta: 这类前缀。"}
              className="w-full min-h-48 border border-neutral-300 dark:border-neutral-600 rounded px-2 py-2 text-sm mb-2 bg-white dark:bg-neutral-800 dark:text-neutral-100 focus:outline-none focus:border-neutral-900 dark:focus:border-neutral-400 resize-y"
            />
            <div className="mb-4 rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] leading-relaxed text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
              预览：将生成 {textSegments.length} 个 segment。系统只做机械转换，不会自动改写你的文稿。
            </div>
          </>
        )}

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!id.trim() || submitting || (inputMode === "json" ? !file : textSegments.length === 0)}
            className="px-3 py-1.5 text-sm bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded hover:bg-neutral-800 dark:hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
