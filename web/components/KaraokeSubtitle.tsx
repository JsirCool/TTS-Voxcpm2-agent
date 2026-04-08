"use client";

import { useEffect, useState } from "react";

interface Props {
  text: string;
  durationS: number;
  isPlaying: boolean;
  /** 字体色(未 playing 时用),用于 dirty 状态换色 */
  baseColorClass?: string;
}

/**
 * 卡拉 OK 字符遮罩。
 * MVP 简化:无真音频,用 setInterval 每 100ms fallback 模拟进度。
 * 已播字符 text-neutral-900 font-medium,未播 text-neutral-300。
 */
export function KaraokeSubtitle({
  text,
  durationS,
  isPlaying,
  baseColorClass = "text-neutral-700",
}: Props) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isPlaying) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const id = window.setInterval(() => {
      setElapsed((e) => {
        const next = e + 0.1;
        if (next >= durationS) {
          window.clearInterval(id);
          return durationS;
        }
        return next;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [isPlaying, durationS]);

  if (!isPlaying) {
    return <span className={baseColorClass}>{text}</span>;
  }

  const pct =
    durationS > 0 ? Math.min(100, (elapsed / durationS) * 100) : 100;
  const chars = Array.from(text);
  const cut = Math.floor((chars.length * pct) / 100);
  const played = chars.slice(0, cut).join("");
  const rest = chars.slice(cut).join("");

  return (
    <>
      <span className="text-neutral-900 font-medium">{played}</span>
      <span className="text-neutral-300">{rest}</span>
      <span className="ml-2 text-[10px] text-neutral-400 font-mono">
        {elapsed.toFixed(1)}s / {durationS.toFixed(1)}s
      </span>
    </>
  );
}
