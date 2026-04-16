"use client";

let activeAudio: HTMLAudioElement | null = null;

function pauseAndReset(audio: HTMLAudioElement) {
  audio.pause();
  try {
    audio.currentTime = 0;
  } catch {
    // Ignore browsers that do not allow currentTime mutation yet.
  }
}

export function playExclusiveAudio(audio: HTMLAudioElement): Promise<void> {
  if (activeAudio && activeAudio !== audio) {
    pauseAndReset(activeAudio);
  }
  activeAudio = audio;
  return audio.play();
}

export function stopExclusiveAudio(audio?: HTMLAudioElement | null) {
  const target = audio ?? activeAudio;
  if (!target) return;
  pauseAndReset(target);
  if (!audio || activeAudio === audio) {
    activeAudio = null;
  }
}

export function releaseExclusiveAudio(audio?: HTMLAudioElement | null) {
  if (audio && activeAudio === audio) {
    activeAudio = null;
  }
}
