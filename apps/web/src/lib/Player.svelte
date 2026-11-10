<script lang="ts">
  import { goto } from "$app/navigation";
  import type { PlaybackInfoResponse, PlaybackSessionResponse as PlaybackSession } from "@tessatv/domain";
  import { api, episodeCode, formatTime } from "$lib/api.js";
  import { detectCapabilities } from "$lib/capabilities.js";
  import Icon from "$lib/Icon.svelte";
  import StreamStats, { type FallbackEvent } from "$lib/StreamStats.svelte";
  import {
    getMaxBitrate,
    getNormalize,
    getVolume,
    pickAudio,
    pickSubtitles,
    rememberAudio,
    rememberSubtitles,
    setMaxBitrate,
    setNormalize,
    setVolume,
  } from "$lib/preferences.js";
  import Hls from "hls.js";
  import { onDestroy, onMount } from "svelte";

  /**
   * One instance per episode: the watch page keys this on the unit id, so moving to another
   * episode tears the old one down (timers, transcode, audio graph) and starts fresh.
   */
  let { info, isAdmin = false }: { info: PlaybackInfoResponse; isAdmin?: boolean } = $props();
  const unitId = $derived(info.unit.id);

  const QUALITIES: { label: string; value: number | null }[] = [
    { label: "Original", value: null },
    { label: "20 Mbps", value: 20_000_000 },
    { label: "8 Mbps", value: 8_000_000 },
    { label: "4 Mbps", value: 4_000_000 },
    { label: "1.5 Mbps", value: 1_500_000 },
  ];
  const PROGRESS_INTERVAL_MS = 10_000;
  const NEXT_COUNTDOWN_SECONDS = 10;
  const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  /** Volume above 1 is boost; the element itself stops at 100%. */
  const MAX_VOLUME = 2;
  /** Mirrors the server's `MAX_FALLBACK_LEVEL`: the H.264/AAC/720p stream every browser plays. */
  const MAX_FALLBACK_LEVEL = 3;
  /** Wanting to play this long without the position moving counts as a stuck stream. */
  const STALL_MS = 20_000;
  /** Long enough playing with no decoded picture to call it a silent video decode failure. */
  const NO_PICTURE_SECONDS = 4;

  let container: HTMLDivElement;
  // State so the stats panel, which gets it as a prop, sees it once it's bound.
  let video: HTMLVideoElement = $state.raw()!;
  let hls = $state.raw<Hls | null>(null);
  let session = $state<PlaybackSession | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let buffering = $state(false);
  let paused = $state(true);
  /** Position within the stream; the source position is this plus `session.startTimeSeconds`. */
  let streamTime = $state(0);
  let scrubbing = $state<number | null>(null);
  let controlsVisible = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let countdown = $state<number | null>(null);
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  /** Set once the viewer cancels; reaching the end again (e.g. seeking there) doesn't re-offer. */
  let declinedNext = false;
  let lastReport = 0;
  /** Until the current session actually plays, its position means nothing — reporting it would wipe the saved one. */
  let started = false;

  /**
   * How far this episode has stepped down to keep playing (see the server's `FallbackLevel`).
   * It only ever goes up while this player lives: whatever failed would just fail again.
   */
  let fallbackLevel = 0;
  let fallbacks = $state<FallbackEvent[]>([]);
  /** Set while a step down is starting, so one failure reported several ways steps once. */
  let fallingBack = false;
  /** hls.js's own recovery gets one try per stream before we step down. */
  let mediaRecoveries = 0;
  let lastMovedAt = 0;
  let lastMovedTime = -1;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let statsOpen = $state(false);
  let lastFragment = $state<{ bytes: number; ms: number } | null>(null);
  /**
   * The browser refused to start playback on its own: Firefox blocks audible autoplay on a
   * page that hasn't been clicked yet (a new tab, a reload), and some Gecko forks ask for a
   * click per play. Shown as a big play button rather than a silently paused player.
   */
  let autoplayBlocked = $state(false);

  let audioIndex = $state<number | null>(null);
  let subtitleIndex = $state<number | null>(null);
  let maxBitrate = $state<number | null>(null);
  /** 0–MAX_VOLUME. Above 1, the extra is applied as gain through Web Audio. */
  let volume = $state(1);
  let audioGraph: { context: AudioContext; gain: GainNode } | null = null;
  let normalize = $state(true);
  /** The browser's audio engine stays suspended until the page has seen a click or key. */
  let userActivated = $state(false);
  /** Gain from the measured loudness, for the stream it was measured on, while normalization is on. */
  const normalizationGain = $derived(
    normalize && info.normalization && info.normalization.audioStreamIndex === audioIndex
      ? 10 ** (info.normalization.gainDb / 20)
      : 1,
  );
  let muted = $state(false);
  let rate = $state(1);
  let fullscreen = $state(false);
  /** Brief centred feedback for keyboard actions ("Volume 40%", "1.5×", "+10s"). */
  let flash = $state<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const offset = $derived(session?.startTimeSeconds ?? 0);
  const position = $derived(scrubbing ?? offset + streamTime);
  const duration = $derived(info.durationSeconds ?? 0);
  const heading = $derived(
    info.title?.isSeries ? `${info.title.title} · ${episodeCode(info.unit)} · ${info.unit.title}` : (info.title?.title ?? info.unit.title),
  );

  onMount(() => {
    audioIndex = pickAudio(info.audioStreams)?.index ?? null;
    subtitleIndex = pickSubtitles(info.subtitleStreams)?.index ?? null;
    maxBitrate = getMaxBitrate();
    ({ volume, muted } = getVolume());
    normalize = getNormalize();
    userActivated = navigator.userActivation?.hasBeenActive ?? false;
    const activate = () => (userActivated = true);
    window.addEventListener("pointerdown", activate, { once: true });
    window.addEventListener("keydown", activate, { once: true });
    const progress = info.unit.progress;
    const resumeAt = progress && !progress.completed ? progress.positionSeconds : 0;
    void start(resumeAt);
    window.addEventListener("pagehide", leave);
    watchdog = setInterval(checkHealth, 1000);
    return () => window.removeEventListener("pagehide", leave);
  });

  onDestroy(() => {
    void audioGraph?.context.close();
    clearInterval(watchdog);
    stopCountdown();
    clearTimeout(hideTimer);
    leave();
  });

  /** Reports progress and stops any transcode; must survive the page unloading. */
  function leave() {
    if (session) {
      reportProgress(true);
      if (session.transcodeId) void fetch(`/api/transcodes/${session.transcodeId}`, { method: "DELETE", keepalive: true });
      session = null;
    }
    hls?.destroy();
    hls = null;
  }

  async function start(startSeconds: number) {
    loading = true;
    error = null;
    const requestedLevel = fallbackLevel;
    const previous = session;
    session = null;
    if (previous?.transcodeId) void fetch(`/api/transcodes/${previous.transcodeId}`, { method: "DELETE" });
    try {
      const { capabilities } = detectCapabilities(Hls.isSupported());
      const next = await api<PlaybackSession>(fetch, `/api/playback/${unitId}/start`, {
        method: "POST",
        body: JSON.stringify({
          capabilities,
          startSeconds,
          ...(audioIndex !== null ? { audioStreamIndex: audioIndex } : {}),
          ...(subtitleIndex !== null ? { subtitleStreamIndex: subtitleIndex } : {}),
          fallbackLevel,
        }),
      });
      // The server steps down by itself when ffmpeg can't start a level.
      if (next.fallbackLevel > requestedLevel) {
        fallbackLevel = next.fallbackLevel;
        fallbacks = [...fallbacks, { level: next.fallbackLevel, reason: "server couldn't start the stream", atSeconds: startSeconds }];
        showFlash("Switched to a more compatible stream");
      }
      attach(next, next.mode === "direct-play" ? startSeconds : 0);
    } catch (cause) {
      error = (cause as Error).message;
      loading = false;
    } finally {
      fallingBack = false;
    }
  }

  /**
   * The stream failed in a way a retry at the same level wouldn't fix (the browser can't
   * decode it, ffmpeg died, it stopped moving): restart from here one level more compatible.
   * Only once the last level fails too is it an error for the viewer.
   */
  function fallBack(reason: string) {
    if (fallingBack || !session) return;
    if (fallbackLevel >= MAX_FALLBACK_LEVEL) {
      error = `Playback failed (${reason})`;
      loading = false;
      return;
    }
    fallingBack = true;
    fallbackLevel += 1;
    const at = position;
    fallbacks = [...fallbacks, { level: fallbackLevel, reason, atSeconds: at }];
    console.warn(`TessaTV: stepping down to fallback level ${fallbackLevel}: ${reason}`);
    showFlash("Switched to a more compatible stream");
    void start(at);
  }

  /**
   * Catches the failures that raise no error: a stream that stops moving while it should be
   * playing (ffmpeg died mid-file, a segment never arrives), and video that "plays" without
   * ever producing a picture (a codec the browser claimed but can't actually decode).
   */
  function checkHealth() {
    if (!session || !video || error || loading || fallingBack || countdown !== null) return;
    const now = Date.now();
    if (video.currentTime !== lastMovedTime || video.paused || video.ended || document.hidden) {
      lastMovedTime = video.currentTime;
      lastMovedAt = now;
    } else if (now - lastMovedAt > STALL_MS) {
      fallBack("stream stalled");
      return;
    }
    const frames = video.getVideoPlaybackQuality?.().totalVideoFrames;
    const playedSeconds = video.played.length ? video.played.end(video.played.length - 1) - video.played.start(0) : 0;
    if (session.hasVideo && started && playedSeconds > NO_PICTURE_SECONDS && (video.videoWidth === 0 || frames === 0)) {
      fallBack("no picture decoded");
    }
  }

  /** Points the video element at a session, then seeks to `streamSeconds` within it. */
  function attach(next: PlaybackSession, streamSeconds: number) {
    hls?.destroy();
    hls = null;
    session = next;
    started = false;
    mediaRecoveries = 0;
    lastMovedAt = Date.now();
    streamTime = streamSeconds;
    const seekWhenReady = () => {
      // An in-progress transcode looks like a live stream; without this, players jump to its end.
      video.currentTime = streamSeconds;
      // A new source resets the rate; volume survives on the element.
      video.playbackRate = rate;
      void video.play().catch((cause: DOMException) => {
        paused = true;
        if (cause.name === "NotAllowedError") autoplayBlocked = true;
      });
    };
    video.addEventListener("loadedmetadata", seekWhenReady, { once: true });

    const { engine } = detectCapabilities(Hls.isSupported());
    if (next.mode === "direct-play" || engine === "native") {
      video.src = next.url;
    } else {
      hls = new Hls({ startPosition: streamSeconds, maxBufferLength: 60 });
      hls.on(Hls.Events.FRAG_LOADED, (_event, { frag }) => {
        lastFragment = { bytes: frag.stats.loaded, ms: frag.stats.loading.end - frag.stats.loading.start };
      });
      hls.on(Hls.Events.ERROR, (_event, details) => {
        if (!details.fatal) return;
        // hls.js's documented recovery for a decode error, before giving up on the stream.
        if (details.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
          if (mediaRecoveries++ === 1) hls?.swapAudioCodec();
          hls?.recoverMediaError();
          return;
        }
        // The transcode was reaped (e.g. after a long pause): same level, fresh transcode.
        const status = details.response?.code;
        if (details.type === Hls.ErrorTypes.NETWORK_ERROR && (status === 404 || status === 410)) {
          void start(position);
          return;
        }
        fallBack(details.details);
      });
      hls.loadSource(next.url);
      hls.attachMedia(video);
    }
  }

  async function seekTo(target: number) {
    const clamped = Math.max(0, Math.min(target, duration || target));
    if (!session) return;
    if (session.mode === "direct-play") {
      video.currentTime = clamped;
      return;
    }
    // Within what the current transcode has produced: just move. Otherwise restart ffmpeg there.
    const available = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    const local = clamped - session.startTimeSeconds;
    if (local >= 0 && local <= available - 1) {
      video.currentTime = local;
      return;
    }
    loading = true;
    try {
      const next = await api<PlaybackSession>(fetch, `/api/playback/${unitId}/seek`, {
        method: "POST",
        body: JSON.stringify({ transcodeId: session.transcodeId, seconds: clamped }),
      });
      attach(next, Math.max(0, clamped - next.startTimeSeconds));
    } catch (cause) {
      // The transcode may have been reaped while paused; start a fresh one.
      const status = (cause as { status?: number }).status;
      if (status === 404) await start(clamped);
      // ffmpeg couldn't restart there: try that spot one level down.
      else if (status === 502) {
        fallbackLevel = Math.min(MAX_FALLBACK_LEVEL, fallbackLevel + 1);
        fallbacks = [...fallbacks, { level: fallbackLevel, reason: "transcode failed after a seek", atSeconds: clamped }];
        await start(clamped);
      } else error = (cause as Error).message;
    }
  }

  function reportProgress(force = false) {
    if (!session || !duration || !started) return;
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    void fetch(`/api/progress/${unitId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionSeconds: offset + video.currentTime, durationSeconds: duration }),
      keepalive: true,
    }).catch(() => {});
  }

  function onEnded() {
    // A transcode that's still catching up can "end" at its current edge; only trust the real end.
    if (duration && offset + video.currentTime < duration - 5) return;
    void fetch(`/api/progress/${unitId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionSeconds: duration, durationSeconds: duration, ended: true }),
    });
    // `ended` can fire more than once (seeking to the end again); never stack a second timer.
    if (info.next && !declinedNext && countdownTimer === undefined) {
      countdown = NEXT_COUNTDOWN_SECONDS;
      countdownTimer = setInterval(() => {
        if (countdown === null) return stopCountdown();
        countdown -= 1;
        if (countdown <= 0) playNext();
      }, 1000);
    }
  }

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = undefined;
    countdown = null;
  }

  function playNext() {
    stopCountdown();
    if (info.next) void goto(`/watch/${info.next.id}`, { replaceState: true });
  }

  function cancelNext() {
    declinedNext = true;
    stopCountdown();
  }

  /**
   * Subtitles come on the source's timeline; a transcode that started partway through
   * restarts its own clock at 0. The browser has already parsed the WebVTT, so just move
   * its cues rather than re-parsing on the server.
   */
  function alignSubtitles(event: Event) {
    const track = (event.currentTarget as HTMLTrackElement).track;
    const shift = session?.startTimeSeconds ?? 0;
    if (shift && track.cues) {
      for (const cue of Array.from(track.cues)) {
        cue.startTime = Math.max(0, cue.startTime - shift);
        cue.endTime -= shift;
      }
    }
    placeSubtitles();
  }

  /**
   * Subtitles render at the bottom of the video, right where the control bar sits; while
   * the controls are showing, move them up out of its way (a negative line counts up from
   * the bottom).
   */
  function placeSubtitles() {
    if (!video) return;
    for (const track of Array.from(video.textTracks)) {
      if (!track.cues) continue;
      for (const cue of Array.from(track.cues) as VTTCue[]) cue.line = controlsVisible ? -4 : "auto";
    }
  }

  $effect(() => {
    void controlsVisible;
    placeSubtitles();
  });

  /** A dropdown keeps focus after a pick; let go of it so the keyboard drives the player again. */
  function release(event: Event) {
    (event.currentTarget as HTMLElement).blur();
  }

  function changeAudio(event: Event) {
    release(event);
    rememberAudio(info.audioStreams.find((stream) => stream.index === audioIndex));
    void start(position);
  }

  function changeSubtitles(event: Event) {
    release(event);
    applySubtitles();
  }

  function applySubtitles() {
    rememberSubtitles(info.subtitleStreams.find((stream) => stream.index === subtitleIndex));
    void start(position);
  }

  /** YouTube's "c": off, or back on in the remembered language (else the first text track). */
  function toggleCaptions() {
    if (info.subtitleStreams.length === 0) return;
    if (subtitleIndex !== null) {
      subtitleIndex = null;
    } else {
      const fallback = info.subtitleStreams.find((stream) => stream.isTextBased && !stream.isForced) ?? info.subtitleStreams[0];
      const remembered = pickSubtitles(info.subtitleStreams);
      subtitleIndex = (remembered && !remembered.isForced ? remembered : fallback)?.index ?? null;
    }
    showFlash(subtitleIndex === null ? "Subtitles off" : "Subtitles on");
    applySubtitles();
  }

  $effect(() => {
    if (!video) return;
    applyGain(Math.max(volume, 1) * normalizationGain);
    if (audioGraph) {
      // Browsers disagree on whether the element's own volume still applies once it feeds
      // Web Audio, so the gain node does all of it: volume, boost, normalization and mute.
      video.volume = 1;
      video.muted = false;
      audioGraph.gain.gain.value = muted ? 0 : volume * normalizationGain;
    } else {
      video.volume = Math.min(volume, 1);
      video.muted = muted;
    }
    // Boost is for one unusually quiet file, so only the ordinary level is remembered.
    setVolume(Math.min(volume, 1), muted);
  });

  /**
   * Applies boost and normalization by routing the element through a gain node, with a
   * limiter after it so raised peaks don't clip. Built on first use only: once an element
   * is routed through Web Audio it stays that way, so a file that needs no gain keeps the
   * browser's direct path. Two cases where Web Audio would silence playback are left alone:
   * before any user interaction (the audio engine starts suspended), and Safari's native
   * HLS, whose media-element source outputs nothing.
   */
  function applyGain(gain: number) {
    if (Math.abs(gain - 1) < 0.01 && !audioGraph) return;
    if (!audioGraph) {
      const nativeHls = session?.mode !== "direct-play" && detectCapabilities(Hls.isSupported()).engine === "native";
      if (!userActivated || !session || nativeHls) return;
      const context = new AudioContext();
      const amplifier = context.createGain();
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      context.createMediaElementSource(video).connect(amplifier).connect(limiter).connect(context.destination);
      audioGraph = { context, gain: amplifier };
    }
    void audioGraph.context.resume();
  }

  function toggleNormalize() {
    normalize = !normalize;
    setNormalize(normalize);
    const gainDb = info.normalization?.gainDb;
    showFlash(
      !normalize
        ? "Normalization off"
        : gainDb === undefined
          ? "Normalization on (not measured yet)"
          : `Normalization on (${gainDb > 0 ? "+" : ""}${gainDb} dB)`,
    );
  }

  const volumeLabel = () => `Volume ${Math.round(volume * 100)}%${volume > 1 ? " (boosted)" : ""}`;

  function showFlash(message: string) {
    flash = message;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash = null), 800);
  }

  function nudgeVolume(delta: number) {
    volume = Math.round(Math.min(MAX_VOLUME, Math.max(0, volume + delta)) * 100) / 100;
    muted = volume === 0;
    showFlash(volumeLabel());
  }

  function toggleMute() {
    muted = !muted;
    if (!muted && volume === 0) volume = 0.5;
    showFlash(muted ? "Muted" : volumeLabel());
  }

  function nudgeRate(direction: 1 | -1) {
    const current = PLAYBACK_RATES.indexOf(rate);
    rate = PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, Math.max(0, current + direction))]!;
    video.playbackRate = rate;
    showFlash(`${rate}×`);
  }

  function skip(seconds: number) {
    showFlash(`${seconds > 0 ? "+" : "−"}${Math.abs(seconds)}s`);
    void seekTo(position + seconds);
  }

  function changeQuality(event: Event) {
    release(event);
    setMaxBitrate(maxBitrate);
    void start(position);
  }

  function togglePlay() {
    if (video.paused) void video.play();
    else video.pause();
  }

  function onFullscreenChange() {
    fullscreen = document.fullscreenElement !== null;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (container.requestFullscreen) void container.requestFullscreen();
    // iOS only allows the video element itself to go fullscreen, with its own controls.
    else (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.();
  }

  function showControls() {
    controlsVisible = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!video.paused) controlsVisible = false;
    }, 3000);
  }

  /** YouTube's player shortcuts. */
  function onKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.length === 1 && !event.shiftKey ? event.key.toLowerCase() : event.key;
    const actions: Record<string, () => void> = {
      " ": togglePlay,
      k: togglePlay,
      j: () => skip(-10),
      l: () => skip(10),
      ArrowLeft: () => skip(-5),
      ArrowRight: () => skip(5),
      ArrowUp: () => nudgeVolume(0.05),
      ArrowDown: () => nudgeVolume(-0.05),
      m: toggleMute,
      f: toggleFullscreen,
      c: toggleCaptions,
      Home: () => void seekTo(0),
      End: () => void seekTo(duration - 1),
      "<": () => nudgeRate(-1),
      ">": () => nudgeRate(1),
      N: playNext,
      ...(isAdmin ? { i: () => (statsOpen = !statsOpen) } : {}),
    };
    for (let digit = 0; digit <= 9; digit++) actions[String(digit)] = () => void seekTo((duration * digit) / 10);
    const action = actions[key];
    if (!action) return;
    // Whatever has focus: otherwise a focused dropdown takes arrow keys as "pick the
    // neighbouring option" and silently switches tracks, and a focused button takes Space
    // as a click.
    event.preventDefault();
    action();
    showControls();
  }
</script>

<svelte:head>
  <title>{heading} · TessaTV</title>
</svelte:head>

<svelte:window onkeydown={onKey} />
<svelte:document onfullscreenchange={onFullscreenChange} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="player fixed inset-0 bg-black text-white select-none" class:idle={!controlsVisible} bind:this={container} onmousemove={showControls}>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    class="size-full object-contain"
    bind:this={video}
    playsinline
    crossorigin="use-credentials"
    onpointerup={(event) => {
      // On touch screens a tap reveals the controls (like every phone player); with a mouse it toggles playback.
      if (event.pointerType === "mouse") togglePlay();
      else if (controlsVisible && !video.paused) controlsVisible = false;
      else showControls();
    }}
    ontimeupdate={() => {
      streamTime = video.currentTime;
      if (!video.paused) reportProgress();
    }}
    onplay={() => {
      paused = false;
      autoplayBlocked = false;
    }}
    onpause={() => {
      paused = true;
      reportProgress(true);
      showControls();
    }}
    onwaiting={() => (buffering = true)}
    onplaying={() => {
      started = true;
      buffering = false;
      loading = false;
    }}
    oncanplay={() => (loading = false)}
    onended={onEnded}
    onerror={() => {
      // Aborted is the page tearing the source down, not a failure.
      if (!video.error || video.error.code === MediaError.MEDIA_ERR_ABORTED) return;
      // With hls.js the same failure arrives as an hls.js error, which handles it.
      if (hls) return;
      fallBack(video.error.message || `media error ${video.error.code}`);
    }}
  >
    {#if session?.subtitleUrl}
      <!-- Keyed on the stream URL: a seek keeps the same subtitle URL but a new time offset. -->
      {#key session.url}
        <track kind="subtitles" src={session.subtitleUrl} default onload={alignSubtitles} />
      {/key}
    {/if}
  </video>

  {#if autoplayBlocked && paused && !error}
    <button
      type="button"
      class="btn btn-warning btn-circle absolute top-1/2 left-1/2 size-20 -translate-1/2"
      onclick={() => void video.play()}
      aria-label="Play"
      title="Play (k)"
    >
      <Icon name="play" class="size-10" />
    </button>
  {:else if loading || buffering}
    <span class="loading loading-spinner loading-lg pointer-events-none absolute top-1/2 left-1/2 -translate-1/2" aria-label="Loading"></span>
  {/if}

  {#if error}
    <div class="card bg-base-200/90 absolute top-1/2 left-1/2 -translate-1/2 p-6 text-center">
      <p class="mb-3">{error}</p>
      <button type="button" class="btn btn-sm" onclick={() => start(position)}>Retry</button>
    </div>
  {/if}

  {#if countdown !== null && info.next}
    <div class="card bg-base-200/90 absolute top-1/2 left-1/2 -translate-1/2 p-6 text-center">
      <p>Up next: {episodeCode(info.next)} · {info.next.title}</p>
      <p class="mb-3 opacity-70">Starting in {countdown}s</p>
      <div class="flex justify-center gap-2">
        <button type="button" class="btn btn-warning btn-sm" onclick={playNext}>Play now</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick={cancelNext}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if statsOpen && isAdmin}
    <StreamStats
      {unitId}
      {video}
      {hls}
      engine={session?.mode === "direct-play" ? "progressive (direct file)" : hls ? `hls.js ${Hls.version}` : "native HLS"}
      {session}
      {position}
      {volume}
      {muted}
      normalizationDb={normalizationGain !== 1 && info.normalization ? info.normalization.gainDb : null}
      {fallbacks}
      {lastFragment}
      onclose={() => (statsOpen = false)}
    />
  {/if}

  {#if flash}
    <div class="badge badge-neutral badge-lg pointer-events-none absolute top-1/4 left-1/2 -translate-x-1/2 bg-black/70">{flash}</div>
  {/if}

  <div class="top absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 py-3">
    <button type="button" class="btn btn-ghost btn-circle btn-sm" onclick={() => history.back()} aria-label="Back" title="Back">
      <Icon name="arrowLeft" />
    </button>
    <span class="heading truncate">{heading}</span>
  </div>

  <div class="controls absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 py-3">
    <input
      class="seek range range-warning range-xs w-full"
      type="range"
      min="0"
      max={duration || 1}
      step="1"
      value={position}
      aria-label="Seek"
      oninput={(event) => (scrubbing = Number(event.currentTarget.value))}
      onchange={(event) => {
        scrubbing = null;
        release(event);
        void seekTo(Number(event.currentTarget.value));
      }}
    />
    <div class="mt-2 flex flex-wrap items-center gap-1">
      <button type="button" class="btn btn-ghost btn-circle btn-sm" onclick={togglePlay} aria-label={paused ? "Play" : "Pause"} title="{paused ? 'Play' : 'Pause'} (k)">
        <Icon name={paused ? "play" : "pause"} />
      </button>
      <button type="button" class="btn btn-ghost btn-circle btn-sm" onclick={() => skip(-10)} aria-label="Back 10 seconds" title="Back 10s (j)">
        <Icon name="back" />
      </button>
      <button type="button" class="btn btn-ghost btn-circle btn-sm" onclick={() => skip(10)} aria-label="Forward 10 seconds" title="Forward 10s (l)">
        <Icon name="ahead" />
      </button>
      {#if info.next}
        <button type="button" class="btn btn-ghost btn-circle btn-sm" onclick={playNext} aria-label="Next episode" title="Next episode (Shift+N)">
          <Icon name="next" />
        </button>
      {/if}
      <div class="group flex items-center">
        <button type="button" class="btn btn-ghost btn-circle btn-sm" onclick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} title="Mute (m)">
          <Icon name={muted || volume === 0 ? "muted" : "volume"} />
        </button>
        <input
          class="range range-xs mx-1 hidden w-28 sm:block"
          class:range-warning={volume > 1 && !muted}
          type="range"
          min="0"
          max={MAX_VOLUME}
          step="0.05"
          value={muted ? 0 : volume}
          aria-label="Volume"
          title="{Math.round(volume * 100)}% — past the middle boosts quiet audio"
          oninput={(event) => {
            volume = Number(event.currentTarget.value);
            muted = volume === 0;
          }}
          onchange={release}
        />
        {#if volume > 1 && !muted}
          <span class="badge badge-warning badge-sm" title="Boosted for this episode">{Math.round(volume * 100)}%</span>
        {/if}
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-circle btn-sm"
        class:text-warning={normalize}
        class:opacity-50={!normalize}
        onclick={toggleNormalize}
        aria-pressed={normalize}
        aria-label="Volume normalization"
        title={normalize
          ? `Volume normalization on${info.normalization ? ` (${info.normalization.gainDb > 0 ? "+" : ""}${info.normalization.gainDb} dB)` : " — not measured yet"}`
          : "Volume normalization off"}
      >
        <Icon name="normalize" />
      </button>
      <span class="time ml-1 text-sm tabular-nums">{formatTime(position)} / {formatTime(duration)}</span>
      <span class="flex-1"></span>
      {#if info.audioStreams.length > 1}
        <label class="select select-sm w-auto" title="Audio track">
          <Icon name="volume" class="size-4 opacity-70" />
          <select bind:value={audioIndex} onchange={changeAudio} aria-label="Audio track">
            {#each info.audioStreams as stream (stream.index)}
              <option value={stream.index}>{stream.label}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if info.subtitleStreams.length > 0}
        <label class="select select-sm w-auto" title="Subtitles (c)">
          <Icon name="subtitles" class="size-4 opacity-70" />
          <select bind:value={subtitleIndex} onchange={changeSubtitles} aria-label="Subtitles">
            <option value={null}>Off</option>
            {#each info.subtitleStreams as stream (stream.index)}
              <option value={stream.index}>{stream.label}</option>
            {/each}
          </select>
        </label>
      {/if}
      <label class="select select-sm w-auto" title="Quality">
        <Icon name="adjustments" class="size-4 opacity-70" />
        <select bind:value={maxBitrate} onchange={changeQuality} aria-label="Quality">
          {#each QUALITIES as quality (quality.label)}
            <option value={quality.value}>{quality.label}</option>
          {/each}
        </select>
      </label>
      {#if isAdmin}
        <button
          type="button"
          class="btn btn-ghost btn-circle btn-sm"
          class:text-warning={statsOpen}
          onclick={() => (statsOpen = !statsOpen)}
          aria-pressed={statsOpen}
          aria-label="Stats for nerds"
          title="Stats for nerds (i)"
        >
          <Icon name="stats" />
        </button>
      {/if}
      <button type="button" class="btn btn-ghost btn-circle btn-sm" onclick={toggleFullscreen} aria-label="Fullscreen" title="Fullscreen (f)">
        <Icon name={fullscreen ? "exitFullscreen" : "fullscreen"} />
      </button>
    </div>
    {#if session && session.mode !== "direct-play"}
      <div class="mt-1 text-xs opacity-60" title={session.reasons.join(", ")}>
        {session.mode === "remux" ? "Remuxing" : "Transcoding"}{session.fallbackLevel > 0 ? " · compatibility mode" : ""}
      </div>
    {/if}
  </div>
</div>

<style>
  .top,
  .controls {
    transition: opacity 0.25s;
  }
  .idle {
    cursor: none;
  }
  .idle .top,
  .idle .controls {
    opacity: 0;
    pointer-events: none;
  }
</style>
