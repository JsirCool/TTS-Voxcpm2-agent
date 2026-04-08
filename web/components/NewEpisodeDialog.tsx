"use client";

import { useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (id: string, file: File) => void | Promise<void>;
}

export function NewEpisodeDialog({ open, onClose, onCreate }: Props) {
  const [id, setId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleCreate = async () => {
    if (!id.trim() || !file) return;
    setSubmitting(true);
    try {
      await onCreate(id.trim(), file);
      setId("");
      setFile(null);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-96 p-5">
        <h2 className="font-semibold mb-4">New Episode</h2>
        <label className="block text-xs text-neutral-500 mb-1">
          Episode ID
        </label>
        <input
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="ch06"
          className="w-full border border-neutral-300 rounded px-2 py-1.5 text-sm mb-3 focus:outline-none focus:border-neutral-900"
        />
        <label className="block text-xs text-neutral-500 mb-1">
          script.json
        </label>
        <input
          type="file"
          accept=".json"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full text-xs mb-4"
        />
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded hover:bg-neutral-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!id.trim() || !file || submitting}
            className="px-3 py-1.5 text-sm bg-neutral-900 text-white rounded hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
