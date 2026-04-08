"use client";

import { useEffect, useRef } from "react";

interface Props {
  log: string[];
}

export function LogViewer({ log }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [log]);

  return (
    <div className="h-32 border-t border-neutral-200 bg-neutral-900 text-neutral-200 overflow-hidden flex flex-col shrink-0">
      <div className="px-4 py-1 border-b border-neutral-800 flex items-center text-[11px] text-neutral-400">
        <span className="uppercase tracking-wide">run.log</span>
        <span className="ml-auto font-mono">tail -f</span>
      </div>
      <div
        ref={ref}
        className="flex-1 overflow-y-auto px-4 py-2 font-mono text-[11px] leading-relaxed"
      >
        {log.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </div>
  );
}
