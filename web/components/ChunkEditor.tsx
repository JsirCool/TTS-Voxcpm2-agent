"use client";

import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import type { Chunk, ChunkEdit } from "@/lib/types";
import {
  getEffectiveChunkControlPrompt,
  getEpisodeControlPrompt,
  hasChunkControlPromptOverride,
  inferTtsMode,
} from "@/lib/tts-config";
import { GRID_COLS } from "./chunks-grid";

interface Props {
  chunk: Chunk;
  episodeConfig: Record<string, unknown>;
  initialDraft?: ChunkEdit;
  onStage: (draft: ChunkEdit) => void;
  onCancel: () => void;
}

type EditingField = "tts" | "prompt" | "sub" | null;

function autoResize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function ChunkEditor({
  chunk,
  episodeConfig,
  initialDraft,
  onStage,
  onCancel,
}: Props) {
  const [ttsValue, setTtsValue] = useState<string>(
    initialDraft?.textNormalized ?? chunk.textNormalized,
  );
  const [subValue, setSubValue] = useState<string>(
    initialDraft?.subtitleText ?? chunk.subtitleText ?? "",
  );

  const episodeControlPrompt = getEpisodeControlPrompt(episodeConfig);
  const hasPromptOverride = hasChunkControlPromptOverride(chunk.metadata);
  const supportsControlPrompt = inferTtsMode(episodeConfig) !== "ultimate_cloning";
  const initialPromptValue = initialDraft?.clearControlPrompt
    ? episodeControlPrompt
    : initialDraft?.controlPrompt !== undefined
      ? initialDraft.controlPrompt
      : getEffectiveChunkControlPrompt(episodeConfig, chunk.metadata);
  const [promptValue, setPromptValue] = useState<string>(initialPromptValue);
  const [editingField, setEditingField] = useState<EditingField>(null);

  const ttsRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const subRef = useRef<HTMLTextAreaElement>(null);

  const isReview = chunk.status === "needs_review";
  const diagnosis = chunk.verifyDiagnosis;
  const latestAttempt = chunk.attemptHistory?.[chunk.attemptHistory.length - 1];

  useEffect(() => {
    const ref = editingField === "tts"
      ? ttsRef
      : editingField === "prompt"
        ? promptRef
        : editingField === "sub"
          ? subRef
          : null;
    if (ref?.current) {
      const el = ref.current;
      autoResize(el);
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    }
  }, [editingField]);

  const handleBlur = useCallback(() => {
    setEditingField(null);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.currentTarget.blur();
    }
  }, []);

  const handleStage = () => {
    const draft: ChunkEdit = {};
    if (ttsValue !== chunk.textNormalized) draft.textNormalized = ttsValue;

    const originalSubtitle = chunk.subtitleText ?? "";
    if (subValue !== originalSubtitle) draft.subtitleText = subValue;

    if (supportsControlPrompt) {
      const normalizedPrompt = promptValue.trim();
      if (normalizedPrompt === episodeControlPrompt) {
        if (hasPromptOverride) {
          draft.clearControlPrompt = true;
        }
      } else {
        draft.controlPrompt = normalizedPrompt;
      }
    }

    onStage(draft);
  };

  const reviewBannerParts: string[] = [];
  if (diagnosis?.type) reviewBannerParts.push(`类型: ${diagnosis.type}`);
  if (diagnosis?.detail) reviewBannerParts.push(diagnosis.detail);
  if (diagnosis?.verdict) reviewBannerParts.push(diagnosis.verdict);

  let reviewAction = "建议先试听当前 take，再决定是重跑还是手动修改。";
  if (diagnosis?.type === "speed_anomaly") {
    reviewAction = "建议优先检查 TTS 文本和语速，再重跑配音。";
  } else if (diagnosis?.type === "silence_anomaly") {
    reviewAction = "建议优先检查停顿和静音段，再决定是否重跑。";
  }

  const subtitlePlaceholder = "未设置时会回退到 text_normalized";
  const subtitleDisplayEmpty = !subValue;
  const promptDisplayEmpty = !promptValue.trim();

  const editorCard = (
    <div
      className={`overflow-hidden rounded-md border bg-white shadow-sm dark:bg-neutral-900 dark:shadow-neutral-900 ${
        isReview
          ? "border-amber-400 dark:border-amber-500"
          : "border-neutral-300 dark:border-neutral-600"
      }`}
    >
      {isReview && reviewBannerParts.length > 0 ? (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <strong className="font-semibold text-amber-700 dark:text-amber-400">需要人工介入</strong>
          <span className="mx-1">·</span>
          {reviewBannerParts.join(" · ")}
          <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
            建议动作：{reviewAction}
          </div>
        </div>
      ) : null}

      <FieldRow label="TTS 源" fieldKey="text_normalized" hint="修改后会重新配音" hintWarn>
        {editingField === "tts" ? (
          <textarea
            ref={ttsRef}
            value={ttsValue}
            onChange={(e) => {
              setTtsValue(e.target.value);
              autoResize(e.currentTarget);
            }}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className="w-full resize-none rounded-[3px] border border-neutral-800 bg-white px-1 py-0.5 text-[11px] leading-relaxed text-neutral-800 outline-none dark:border-neutral-400 dark:bg-neutral-800 dark:text-neutral-200"
          />
        ) : (
          <div
            onClick={() => setEditingField("tts")}
            className="min-h-[18px] cursor-text whitespace-pre-wrap break-words rounded-[3px] border border-transparent px-1 py-0.5 text-[11px] leading-relaxed text-neutral-800 hover:border-neutral-200 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:border-neutral-700 dark:hover:bg-neutral-800"
          >
            {ttsValue}
          </div>
        )}
      </FieldRow>

      {supportsControlPrompt ? (
        <FieldRow
          label="Control Prompt"
          fieldKey="tts_control_prompt_override"
          hint={hasPromptOverride ? "当前是 chunk 覆盖值" : "留空时跟随全局"}
          hintWarn
        >
          {editingField === "prompt" ? (
            <textarea
              ref={promptRef}
              value={promptValue}
              placeholder="留空可禁用这一条的 Control Prompt"
              onChange={(e) => {
                setPromptValue(e.target.value);
                autoResize(e.currentTarget);
              }}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              className="w-full resize-none rounded-[3px] border border-neutral-800 bg-white px-1 py-0.5 font-mono text-[11px] leading-relaxed text-neutral-800 outline-none dark:border-neutral-400 dark:bg-neutral-800 dark:text-neutral-200"
            />
          ) : (
            <div
              onClick={() => setEditingField("prompt")}
              className={`min-h-[18px] cursor-text whitespace-pre-wrap break-all rounded-[3px] border border-transparent px-1 py-0.5 text-[11px] leading-relaxed hover:border-neutral-200 hover:bg-neutral-100 dark:hover:border-neutral-700 dark:hover:bg-neutral-800 ${
                promptDisplayEmpty
                  ? "italic text-neutral-400 dark:text-neutral-500"
                  : "font-mono text-neutral-800 dark:text-neutral-200"
              }`}
            >
              {promptDisplayEmpty ? "未设置" : promptValue}
            </div>
          )}
        </FieldRow>
      ) : null}

      <FieldRow label="字幕" fieldKey="subtitle_text" hint="修改后会重新出字">
        {editingField === "sub" ? (
          <textarea
            ref={subRef}
            value={subValue}
            placeholder={subtitlePlaceholder}
            onChange={(e) => {
              setSubValue(e.target.value);
              autoResize(e.currentTarget);
            }}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className="w-full resize-none rounded-[3px] border border-neutral-800 bg-white px-1 py-0.5 text-[11px] leading-relaxed text-neutral-800 outline-none dark:border-neutral-400 dark:bg-neutral-800 dark:text-neutral-200"
          />
        ) : (
          <div
            onClick={() => setEditingField("sub")}
            className={`min-h-[18px] cursor-text whitespace-pre-wrap break-words rounded-[3px] border border-transparent px-1 py-0.5 text-[11px] leading-relaxed hover:border-neutral-200 hover:bg-neutral-100 dark:hover:border-neutral-700 dark:hover:bg-neutral-800 ${
              subtitleDisplayEmpty
                ? "italic text-neutral-400 dark:text-neutral-500"
                : "text-neutral-800 dark:text-neutral-200"
            }`}
          >
            {subtitleDisplayEmpty ? subtitlePlaceholder : subValue}
          </div>
        )}
      </FieldRow>

      <FieldRow label="原文" fieldKey="text" hint="只读">
        <div className="min-h-[18px] cursor-default whitespace-pre-wrap break-words px-1 py-0.5 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
          {chunk.text}
        </div>
      </FieldRow>

      <FieldRow label="ASR 回写" fieldKey="transcribed_text" hint="只读" isLast>
        <div className="min-h-[18px] cursor-default whitespace-pre-wrap break-words px-1 py-0.5 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          {latestAttempt?.transcribedText || "还没有可对照的 WhisperX 回写结果"}
        </div>
      </FieldRow>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-neutral-100 px-3 py-1.5 dark:border-neutral-700">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleStage}
          className="rounded bg-amber-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-700"
        >
          暂存修改
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCancel}
          className="rounded px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          关闭
        </button>
        <span className="ml-auto text-[9px] text-neutral-400 dark:text-neutral-500">
          暂存后，顶部“统一应用”才会真正执行
        </span>
      </div>
    </div>
  );

  return (
    <div className="border-b border-neutral-100 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900/50">
      <div className="hidden md:grid" style={{ gridTemplateColumns: GRID_COLS }}>
        <div className="col-span-4" />
        <div className="col-span-2 min-w-0 py-2 pr-6">{editorCard}</div>
      </div>
      <div className="px-4 py-2 md:hidden">{editorCard}</div>
    </div>
  );
}

function FieldRow({
  label,
  fieldKey,
  hint,
  hintWarn,
  isLast,
  children,
}: {
  label: string;
  fieldKey: string;
  hint: string;
  hintWarn?: boolean;
  isLast?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex items-start gap-2 px-3 py-1.5 ${
        isLast ? "" : "border-b border-neutral-100 dark:border-neutral-700/50"
      }`}
    >
      <div className="w-[96px] shrink-0 pt-0.5">
        <div className="text-[11px] font-semibold text-neutral-500 dark:text-neutral-400">
          {label}
        </div>
        <div className="text-[9px] font-mono text-neutral-300 dark:text-neutral-600 break-all">
          {fieldKey}
        </div>
      </div>

      <div className="min-w-0 flex-1">{children}</div>

      <div
        className={`hidden max-w-[92px] shrink-0 pt-1 text-right text-[9px] leading-tight lg:block ${
          hintWarn
            ? "text-amber-700 dark:text-amber-500"
            : "text-neutral-400 dark:text-neutral-500"
        }`}
      >
        {hint}
      </div>
    </div>
  );
}
