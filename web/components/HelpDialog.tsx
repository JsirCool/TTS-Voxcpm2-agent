"use client";

import { useEffect } from "react";
import { CHUNK_STAGE_ORDER } from "@/lib/types";
import { STAGE_INFO } from "@/lib/stage-info";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function HelpDialog({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const codeClass = "rounded bg-neutral-100 px-1 py-0.5 text-xs font-mono dark:bg-neutral-800";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-neutral-900 dark:shadow-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-neutral-200 px-5 py-3 dark:border-neutral-700">
          <span className="text-lg">说明</span>
          <h2 className="flex-1 text-sm font-semibold">使用说明</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-lg leading-none text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
          <section className="mb-6">
            <h3 className="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
              脚本与 TTS 配置
            </h3>
            <p className="mb-3 text-neutral-600 dark:text-neutral-400">
              现在的 P2 使用本地 VoxCPM，不再走 Fish Audio。你可以在 episode config
              里覆盖 VoxCPM 的关键参数，而不会影响别的 episode。
            </p>

            <h4 className="mb-1.5 mt-4 font-semibold">配置优先级</h4>
            <pre className="mb-3 rounded border border-neutral-200 bg-neutral-50 p-2.5 text-xs font-mono dark:border-neutral-700 dark:bg-neutral-800">
{`env var  >  episode.config  >  .harness/config.json  >  code defaults`}
            </pre>

            <h4 className="mb-1.5 mt-4 font-semibold">Script 示例</h4>
            <pre className="mb-3 overflow-x-auto rounded bg-neutral-900 p-3 text-xs font-mono text-neutral-100 dark:bg-neutral-800">
{`{
  "title": "VoxCPM episode",
  "tts_config": {
    "cfg_value": 2.0,
    "inference_timesteps": 10,
    "control_prompt": "young female voice, warm and gentle",
    "reference_audio_path": "E:\\\\audio\\\\speaker.wav",
    "normalize": false,
    "denoise": false
  },
  "segments": [
    { "id": 1, "type": "hook", "text": "..." }
  ]
}`}
            </pre>

            <h4 className="mb-1.5 mt-4 font-semibold">支持字段</h4>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-neutral-50 dark:bg-neutral-800">
                    <th className="border border-neutral-200 px-2 py-1.5 text-left font-mono dark:border-neutral-700">字段</th>
                    <th className="border border-neutral-200 px-2 py-1.5 text-left dark:border-neutral-700">类型</th>
                    <th className="border border-neutral-200 px-2 py-1.5 text-left dark:border-neutral-700">默认</th>
                    <th className="border border-neutral-200 px-2 py-1.5 text-left dark:border-neutral-700">说明</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["cfg_value", "number", "2.0", "VoxCPM guidance scale"],
                    ["inference_timesteps", "number", "10", "扩散步数，越高越稳但越慢"],
                    ["control_prompt", "string", '""', "自动拼成 `(control)正文` 的风格提示"],
                    ["reference_audio_path", "string", '""', "本地参考音频路径，用于音色克隆"],
                    ["prompt_audio_path", "string", '""', "本地 prompt 音频路径，用于高保真续写"],
                    ["prompt_text", "string", '""', "与 prompt 音频对应的真实文本"],
                    ["normalize", "boolean", "false", "是否启用文本标准化"],
                    ["denoise", "boolean", "false", "是否对参考音频做降噪增强"],
                  ].map(([field, type, def, desc]) => (
                    <tr key={field}>
                      <td className="border border-neutral-200 px-2 py-1.5 font-mono dark:border-neutral-700">{field}</td>
                      <td className="border border-neutral-200 px-2 py-1.5 dark:border-neutral-700">{type}</td>
                      <td className="border border-neutral-200 px-2 py-1.5 font-mono dark:border-neutral-700">{def}</td>
                      <td className="border border-neutral-200 px-2 py-1.5 dark:border-neutral-700">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4 className="mb-1.5 mt-4 font-semibold">环境变量</h4>
            <ul className="space-y-1 text-xs text-neutral-700 dark:text-neutral-300">
              <li><code className={codeClass}>VOXCPM_URL</code> 指向本地 VoxCPM 服务。</li>
              <li><code className={codeClass}>WHISPERX_URL</code> 指向本地 WhisperX 服务。</li>
              <li><code className={codeClass}>VOXCPM_CFG_VALUE</code> / <code className={codeClass}>VOXCPM_INFERENCE_TIMESTEPS</code> 可覆盖默认推理参数。</li>
              <li><code className={codeClass}>VOXCPM_REFERENCE_AUDIO_PATH</code> 可设置全局默认参考音频。</li>
            </ul>
          </section>

          <section className="mb-6">
            <h3 className="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
              本地服务
            </h3>
            <p className="mb-2 text-neutral-600 dark:text-neutral-400">
              这个版本默认要求两个本地服务都在线：
            </p>
            <ul className="space-y-1 text-xs text-neutral-700 dark:text-neutral-300">
              <li><code className={codeClass}>voxcpm-svc</code>：负责 P2 合成，常驻加载 GPU 模型。</li>
              <li><code className={codeClass}>whisperx-svc</code>：负责 P2v / P3 转写和时间戳。</li>
            </ul>
          </section>

          <section>
            <h3 className="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
              Chunk 处理链
            </h3>
            <p className="mb-2 text-neutral-600 dark:text-neutral-400">
              每个 chunk 下方的 {CHUNK_STAGE_ORDER.length} 个 pill 表示当前处理状态：
            </p>
            <p className="mb-3 text-xs text-neutral-700 dark:text-neutral-300">
              {CHUNK_STAGE_ORDER.map((stage, i) => {
                const info = STAGE_INFO[stage];
                const label = info.title.split(" · ")[0];
                return (
                  <span key={stage}>
                    <span className="mx-1 inline-block rounded bg-emerald-500 px-1.5 text-[10px] font-mono text-white">
                      {label}
                    </span>
                    {info.description}
                    {i < CHUNK_STAGE_ORDER.length - 1 && " → "}
                  </span>
                );
              })}
            </p>
            <ul className="mt-2 space-y-1 text-xs text-neutral-700 dark:text-neutral-300">
              <li><span className="mr-1 inline-block h-3 w-3 rounded-full bg-emerald-500 align-middle" />深绿 = 真正执行成功</li>
              <li><span className="mr-1 inline-block h-3 w-3 rounded-full bg-red-500 align-middle" />红色 = 当前阶段失败</li>
              <li><span className="mr-1 inline-block h-3 w-3 rounded-full bg-blue-500 align-middle" />蓝色脉冲 = 正在运行</li>
              <li><span className="mr-1 inline-block h-3 w-3 rounded-full bg-neutral-300 align-middle dark:bg-neutral-600" />灰色 = 尚未开始</li>
            </ul>
          </section>
        </div>

        <div className="flex items-center justify-between border-t border-neutral-200 px-5 py-2.5 text-[11px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          <span>按 Esc 关闭</span>
          <span>详细说明见本地 README</span>
        </div>
      </div>
    </div>
  );
}
