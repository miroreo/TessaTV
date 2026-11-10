<script lang="ts">
  import { goto } from "$app/navigation";
  import type { PlaybackSessionResponse as PlaybackSession } from "@tessatv/domain";
  import { api, episodeCode, formatTime } from "$lib/api.js";
  import { detectCapabilities, getMaxBitrate, setMaxBitrate } from "$lib/capabilities.js";
  import Hls from "hls.js";
  import { onDestroy, onMount } from "svelte";
  import type { PageData } from "./$types.js";

  let { data }: { data: PageData } = $props();
  const info = $derived(data.info);
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

  let container: HTMLDivElement;
  let video: HTMLVideoElement;
  let hls: Hls | null = null;
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
  let lastReport = 0;
  /** Until the current session actually plays, its position means nothing — reporting it would wipe the saved one. */
  let started = false;

  let audioIndex = $state<number | null>(null);
  let subtitleIndex = $state<number | null>(null);
  let maxBitrate = $state<number | null>(null);

  const offset = $derived(session?.startTimeSeconds ?? 0);
  const position = $derived(scrubbing ?? offset + streamTime);
  const duration = $derived(info.durationSeconds ?? 0);
  const heading = $derived(
    info.title?.isSeries ? `${info.title.title} · ${episodeCode(info.unit)} · ${info.unit.title}` : (info.title?.title ?? info.unit.title),
  );

  onMount(() => {
    audioIndex = info.audioStreams.find((stream) => stream.isDefault)?.index ?? info.audioStreams[0]?.index ?? null;
    // Subtitles stay off unless the file marks a forced track (foreign-language dialogue).
    subtitleIndex = info.subtitleStreams.find((stream) => stream.isForced)?.index ?? null;
    maxBitrate = getMaxBitrate();
    const progress = info.unit.progress;
    const resumeAt = progress && !progress.completed ? progress.positionSeconds : 0;
    void start(resumeAt);
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  });

  onDestroy(() => {
    clearInterval(countdownTimer);
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
        }),
      });
      attach(next, next.mode === "direct-play" ? startSeconds : 0);
    } catch (cause) {
      error = (cause as Error).message;
      loading = false;
    }
  }

  /** Points the video element at a session, then seeks to `streamSeconds` within it. */
  function attach(next: PlaybackSession, streamSeconds: number) {
    hls?.destroy();
    hls = null;
    session = next;
    started = false;
    streamTime = streamSeconds;
    const seekWhenReady = () => {
      // An in-progress transcode looks like a live stream; without this, players jump to its end.
      video.currentTime = streamSeconds;
      void video.play().catch(() => (paused = true));
    };
    video.addEventListener("loadedmetadata", seekWhenReady, { once: true });

    const { engine } = detectCapabilities(Hls.isSupported());
    if (next.mode === "direct-play" || engine === "native") {
      video.src = next.url;
    } else {
      hls = new Hls({ startPosition: streamSeconds, maxBufferLength: 60 });
      hls.on(Hls.Events.ERROR, (_event, details) => {
        if (details.fatal) error = `Playback failed (${details.details})`;
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
      if ((cause as { status?: number }).status === 404) await start(clamped);
      else error = (cause as Error).message;
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
    if (info.next) {
      countdown = NEXT_COUNTDOWN_SECONDS;
      countdownTimer = setInterval(() => {
        countdown = (countdown ?? 1) - 1;
        if (countdown <= 0) playNext();
      }, 1000);
    }
  }

  function playNext() {
    clearInterval(countdownTimer);
    countdown = null;
    if (info.next) void goto(`/watch/${info.next.id}`, { replaceState: true });
  }

  function cancelNext() {
    clearInterval(countdownTimer);
    countdown = null;
  }

  /**
   * Subtitles come on the source's timeline; a transcode that started partway through
   * restarts its own clock at 0. The browser has already parsed the WebVTT, so just move
   * its cues rather than re-parsing on the server.
   */
  function alignSubtitles(event: Event) {
    const track = (event.currentTarget as HTMLTrackElement).track;
    const shift = session?.startTimeSeconds ?? 0;
    if (!shift || !track.cues) return;
    for (const cue of Array.from(track.cues)) {
      cue.startTime = Math.max(0, cue.startTime - shift);
      cue.endTime -= shift;
    }
  }

  function changeTracks() {
    void start(position);
  }

  function changeQuality() {
    setMaxBitrate(maxBitrate);
    void start(position);
  }

  function togglePlay() {
    if (video.paused) void video.play();
    else video.pause();
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

  function onKey(event: KeyboardEvent) {
    if ((event.target as HTMLElement).closest("select, input")) return;
    const actions: Record<string, () => void> = {
      " ": togglePlay,
      k: togglePlay,
      f: toggleFullscreen,
      ArrowLeft: () => void seekTo(position - 10),
      ArrowRight: () => void seekTo(position + 30),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
    showControls();
  }
</script>

<svelte:head>
  <title>{heading} · TessaTV</title>
</svelte:head>

<svelte:window onkeydown={onKey} />

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
    onplay={() => (paused = false)}
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
      if (video.error) error = `Playback failed (${video.error.message || `code ${video.error.code}`})`;
    }}
  >
    {#if session?.subtitleUrl}
      <!-- Keyed on the stream URL: a seek keeps the same subtitle URL but a new time offset. -->
      {#key session.url}
        <track kind="subtitles" src={session.subtitleUrl} default onload={alignSubtitles} />
      {/key}
    {/if}
  </video>

  {#if loading || buffering}
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

  <div class="top absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 py-3">
    <button type="button" class="btn btn-ghost btn-sm" onclick={() => history.back()} aria-label="Back">←</button>
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
        void seekTo(Number(event.currentTarget.value));
      }}
    />
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" class="btn btn-ghost btn-sm" onclick={togglePlay} aria-label={paused ? "Play" : "Pause"}>{paused ? "▶" : "❚❚"}</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick={() => seekTo(position - 10)} aria-label="Back 10 seconds">−10</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick={() => seekTo(position + 30)} aria-label="Forward 30 seconds">+30</button>
      <span class="time text-sm tabular-nums">{formatTime(position)} / {formatTime(duration)}</span>
      <span class="flex-1"></span>
      {#if info.next}
        <button type="button" class="btn btn-ghost btn-sm" onclick={playNext} title="Next episode">⏭</button>
      {/if}
      {#if info.audioStreams.length > 1}
        <select class="select select-sm w-auto" bind:value={audioIndex} onchange={changeTracks} aria-label="Audio track">
          {#each info.audioStreams as stream (stream.index)}
            <option value={stream.index}>{stream.label}</option>
          {/each}
        </select>
      {/if}
      {#if info.subtitleStreams.length > 0}
        <select class="select select-sm w-auto" bind:value={subtitleIndex} onchange={changeTracks} aria-label="Subtitles">
          <option value={null}>Subtitles off</option>
          {#each info.subtitleStreams as stream (stream.index)}
            <option value={stream.index}>{stream.label}</option>
          {/each}
        </select>
      {/if}
      <select class="select select-sm w-auto" bind:value={maxBitrate} onchange={changeQuality} aria-label="Quality">
        {#each QUALITIES as quality (quality.label)}
          <option value={quality.value}>{quality.label}</option>
        {/each}
      </select>
      <button type="button" class="btn btn-ghost btn-sm" onclick={toggleFullscreen} aria-label="Fullscreen">⛶</button>
    </div>
    {#if session && session.mode !== "direct-play"}
      <div class="mt-1 text-xs opacity-60" title={session.reasons.join(", ")}>{session.mode === "remux" ? "Remuxing" : "Transcoding"}</div>
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
