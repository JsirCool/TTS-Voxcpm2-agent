"use client";

import type { Chunk, ChunkEdit, EditBatch } from "@/lib/types";
import { ChunkRow, type DirtyType } from "./ChunkRow";
import { ChunkEditor } from "./ChunkEditor";

interface Props {
  chunks: Chunk[];
  edits: EditBatch;
  editing: string | null;
  playingChunkId: string | null;
  onPlay: (cid: string) => void;
  onEdit: (cid: string) => void;
  onCancelEdit: () => void;
  onStage: (cid: string, draft: ChunkEdit) => void;
}

function computeDirty(edit: ChunkEdit | undefined): DirtyType {
  if (!edit) return null;
  const hasTts = edit.textNormalized !== undefined;
  const hasSub = edit.subtitleText !== undefined;
  if (hasTts && hasSub) return "both";
  if (hasTts) return "tts";
  if (hasSub) return "subtitle";
  return null;
}

export function ChunksTable({
  chunks,
  edits,
  editing,
  playingChunkId,
  onPlay,
  onEdit,
  onCancelEdit,
  onStage,
}: Props) {
  if (chunks.length === 0) {
    return (
      <div className="px-6 py-12 text-center text-sm text-neutral-400">
        还没有 chunks。点 Run 开始第一次合成。
      </div>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead className="text-[11px] text-neutral-400 uppercase tracking-wide">
        <tr className="border-b border-neutral-100">
          <th className="text-left font-medium px-6 py-2 w-44">ID</th>
          <th className="text-left font-medium py-2 w-12">St</th>
          <th className="text-left font-medium py-2 w-16">Dur</th>
          <th className="text-left font-medium py-2 w-12">Play</th>
          <th className="text-left font-medium py-2 pr-6">Subtitle</th>
          <th className="text-right font-medium py-2 pr-6 w-12">Edit</th>
        </tr>
      </thead>
      <tbody>
        {chunks.map((c) => {
          const isEditing = editing === c.id;
          const edit = edits[c.id];
          const dirty = computeDirty(edit);
          return (
            <RowGroup
              key={c.id}
              chunk={c}
              isEditing={isEditing}
              isPlaying={playingChunkId === c.id}
              dirty={dirty}
              edit={edit}
              onPlay={() => onPlay(c.id)}
              onEdit={() => onEdit(c.id)}
              onCancelEdit={onCancelEdit}
              onStage={(draft) => onStage(c.id, draft)}
            />
          );
        })}
      </tbody>
    </table>
  );
}

interface RowGroupProps {
  chunk: Chunk;
  isEditing: boolean;
  isPlaying: boolean;
  dirty: DirtyType;
  edit: ChunkEdit | undefined;
  onPlay: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onStage: (draft: ChunkEdit) => void;
}

function RowGroup({
  chunk,
  isEditing,
  isPlaying,
  dirty,
  edit,
  onPlay,
  onEdit,
  onCancelEdit,
  onStage,
}: RowGroupProps) {
  return (
    <>
      <ChunkRow
        chunk={chunk}
        isPlaying={isPlaying}
        isEditing={isEditing}
        dirty={dirty}
        edit={edit}
        onPlay={onPlay}
        onEdit={onEdit}
        onCancelEdit={onCancelEdit}
      />
      {isEditing ? (
        <ChunkEditor
          chunk={chunk}
          initialDraft={edit}
          onStage={onStage}
          onCancel={onCancelEdit}
        />
      ) : null}
    </>
  );
}
