import { useCallback, useEffect, useRef, useState } from "react";
import { useHarnessStore } from "@/lib/store";
import { playExclusiveAudio, releaseExclusiveAudio, stopExclusiveAudio } from "@/lib/audio-session";

interface AudioPlayer {
  ref: React.RefObject<HTMLAudioElement | null>;
  currentTime: number;
  isPlaying: boolean;
  toggle: () => void;
  seekTo: (timeS: number) => void;
}

export function useAudioPlayer(chunkId: string, durationS: number): AudioPlayer {
  const ref = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const isPlaying = useHarnessStore((s) => s.playingChunkId === chunkId);
  const setPlayingChunkId = useHarnessStore((s) => s.setPlayingChunkId);
  const continuousPlay = useHarnessStore((s) => s.continuousPlay);
  const advanceToNext = useHarnessStore((s) => s.advanceToNext);
  const playbackRate = useHarnessStore((s) => s.playbackRate);

  // Sync time + handle ended
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTime = () => setCurrentTime(el.currentTime);
    const onPause = () => {
      if (el.currentTime <= 0.05) {
        setCurrentTime(0);
      }
    };
    const onEnded = () => {
      setCurrentTime(0);
      releaseExclusiveAudio(el);
      const { continuousPlay } = useHarnessStore.getState();
      if (continuousPlay) {
        advanceToNext();
      } else {
        setPlayingChunkId(null);
      }
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
  }, [setPlayingChunkId, advanceToNext]);

  // Sync playbackRate to audio element
  useEffect(() => {
    if (ref.current) ref.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // When isPlaying changes: pause if false, auto-play if true (for continuous mode)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let onLoadedMetadata: (() => void) | null = null;
    if (!isPlaying) {
      stopExclusiveAudio(el);
      setCurrentTime(0);
    } else {
      const startPlayback = () => {
        if (cancelled) return;
        el.playbackRate = playbackRate;
        playExclusiveAudio(el).catch(() => {});
      };
      if (el.readyState >= 1) {
        startPlayback();
      } else {
        onLoadedMetadata = () => startPlayback();
        el.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
      }
    }
    return () => {
      cancelled = true;
      if (onLoadedMetadata) {
        el.removeEventListener("loadedmetadata", onLoadedMetadata);
      }
    };
  }, [isPlaying, playbackRate]);

  const ensureReady = useCallback(async () => {
    const el = ref.current;
    if (!el) return null;
    if (el.readyState < 1) {
      await new Promise<void>((resolve) =>
        el.addEventListener("loadedmetadata", () => resolve(), { once: true })
      );
    }
    return el;
  }, []);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (isPlaying) {
      setPlayingChunkId(null);
    } else {
      setPlayingChunkId(chunkId);
      ensureReady().then((ready) => {
        if (ready) {
          ready.playbackRate = playbackRate;
          playExclusiveAudio(ready).catch(() => {});
        }
      });
    }
  }, [chunkId, isPlaying, setPlayingChunkId, ensureReady, playbackRate]);

  const seekTo = useCallback((timeS: number) => {
    const target = Math.max(0, Math.min(durationS, timeS));
    setPlayingChunkId(chunkId);
    ensureReady().then((el) => {
      if (!el) return;
      el.playbackRate = playbackRate;
      el.currentTime = target;
      setCurrentTime(target);
      playExclusiveAudio(el).catch(() => {});
    });
  }, [chunkId, durationS, setPlayingChunkId, ensureReady, playbackRate]);

  return { ref, currentTime, isPlaying, toggle, seekTo };
}
