import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useHarnessStore } from "@/lib/store";
import { playExclusiveAudio, releaseExclusiveAudio, stopExclusiveAudio } from "@/lib/audio-session";

interface AudioPlayer {
  ref: React.RefObject<HTMLAudioElement | null>;
  currentTime: number;
  isPlaying: boolean;
  toggle: () => void;
  seekTo: (timeS: number) => void;
}

function isBenignPlaybackInterruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return error instanceof DOMException && error.name === "AbortError"
    || /interrupted by a call to pause\(\)/i.test(message)
    || /interrupted by a new load request/i.test(message)
    || /play\(\) request was interrupted/i.test(message);
}

function describeMediaError(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "播放被浏览器中断了。";
    case MediaError.MEDIA_ERR_NETWORK:
      return "音频请求失败，请检查 API 和网络。";
    case MediaError.MEDIA_ERR_DECODE:
      return "浏览器没能解码这条音频。";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "浏览器不支持当前音频地址或格式。";
    default:
      return "浏览器没有成功播放这条音频。";
  }
}

function notifyPlaybackFailure(error?: unknown, mediaError?: MediaError | null) {
  if (isBenignPlaybackInterruption(error)) return;
  const description = error instanceof Error
    ? error.message
    : describeMediaError(mediaError ?? null);
  toast.error("音频播放失败", { description });
}

export function useAudioPlayer(chunkId: string, durationS: number, audioUrl: string): AudioPlayer {
  const ref = useRef<HTMLAudioElement>(null);
  const pendingSeekRef = useRef<number | null>(null);
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
    const onError = () => {
      releaseExclusiveAudio(el);
      setPlayingChunkId(null);
      notifyPlaybackFailure(undefined, el.error);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
    };
  }, [audioUrl, setPlayingChunkId, advanceToNext]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    stopExclusiveAudio(el);
    el.muted = false;
    el.volume = 1;
    if (audioUrl) {
      el.load();
    }
    setCurrentTime(0);
  }, [audioUrl]);

  // Sync playbackRate to audio element
  useEffect(() => {
    if (ref.current) ref.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // When isPlaying changes: pause if false, auto-play if true (for continuous mode)
  useEffect(() => {
    const el = ref.current;
    if (!el || !audioUrl) return;
    let cancelled = false;
    let onLoadedMetadata: (() => void) | null = null;
    if (!isPlaying) {
      stopExclusiveAudio(el);
      setCurrentTime(0);
    } else {
      const startPlayback = () => {
        if (cancelled) return;
        el.playbackRate = playbackRate;
        if (pendingSeekRef.current != null) {
          el.currentTime = pendingSeekRef.current;
          setCurrentTime(pendingSeekRef.current);
          pendingSeekRef.current = null;
        }
        playExclusiveAudio(el).catch((error) => {
          if (!cancelled) notifyPlaybackFailure(error, el.error);
        });
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
  }, [audioUrl, isPlaying, playbackRate]);

  const ensureReady = useCallback(async () => {
    const el = ref.current;
    if (!el || !audioUrl) return null;
    if (el.readyState < 1) {
      await new Promise<void>((resolve) =>
        el.addEventListener("loadedmetadata", () => resolve(), { once: true })
      );
    }
    return el;
  }, [audioUrl]);

  const toggle = useCallback(() => {
    if (!audioUrl) return;
    if (isPlaying) {
      setPlayingChunkId(null);
    } else {
      setPlayingChunkId(chunkId);
    }
  }, [audioUrl, chunkId, isPlaying, setPlayingChunkId]);

  const seekTo = useCallback((timeS: number) => {
    const target = Math.max(0, Math.min(durationS, timeS));
    if (!audioUrl) return;
    pendingSeekRef.current = target;
    setCurrentTime(target);
    if (!isPlaying) {
      setPlayingChunkId(chunkId);
      return;
    }
    ensureReady().then((el) => {
      if (!el) return;
      el.playbackRate = playbackRate;
      el.currentTime = target;
      setCurrentTime(target);
      pendingSeekRef.current = null;
      playExclusiveAudio(el).catch((error) => {
        notifyPlaybackFailure(error, el.error);
      });
    });
  }, [audioUrl, chunkId, durationS, ensureReady, isPlaying, playbackRate, setPlayingChunkId]);

  return { ref, currentTime, isPlaying, toggle, seekTo };
}
