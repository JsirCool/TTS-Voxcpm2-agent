"use client";

import type { LocalServiceStatusSnapshot } from "@/lib/hooks";

type ServiceState = boolean | null | undefined;

function dotClass(state: ServiceState): string {
  if (state === true) return "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)]";
  if (state === false) return "bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.14)]";
  return "bg-amber-400 shadow-[0_0_0_3px_rgba(245,158,11,0.14)]";
}

function statusText(state: ServiceState): string {
  if (state === true) return "可用";
  if (state === false) return "不可用";
  return "检测中";
}

function ServicePill({
  label,
  state,
  detail,
}: {
  label: string;
  state: ServiceState;
  detail?: string | null;
}) {
  const title = `${label}: ${statusText(state)}${detail ? ` - ${detail}` : ""}`;
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5"
    >
      <span className={`h-2.5 w-2.5 rounded-full ${dotClass(state)}`} />
      <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
    </span>
  );
}

export function LocalServiceStatus({
  status,
}: {
  status?: LocalServiceStatusSnapshot;
}) {
  return (
    <div className="hidden items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50/80 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800/70 md:flex">
      <ServicePill
        label="Harness API"
        state={status?.harnessApi}
        detail={status?.errors.harnessApi}
      />
      <ServicePill
        label="VoxCPM"
        state={status?.voxcpm}
        detail={status?.errors.voxcpm ?? status?.errors.capabilities}
      />
      <ServicePill
        label="WhisperX"
        state={status?.whisperx}
        detail={status?.errors.whisperx ?? status?.errors.capabilities}
      />
    </div>
  );
}
