<script lang="ts">
  import type { UnitSummary } from "@tessatv/domain";
  import { invalidateAll } from "$app/navigation";
  import { episodeCode, formatTime, progressFraction } from "$lib/api.js";
  import Icon from "$lib/Icon.svelte";
  import { forgetPosition, setWatched } from "$lib/watched.js";
  import WatchedMenu from "$lib/WatchedMenu.svelte";
  import type { PageData } from "./$types.js";

  let { data }: { data: PageData } = $props();
  const view = $derived(data.view);
  const title = $derived(view.title);

  // Opens on the season of whatever "play" would start.
  let chosenSeason = $state<number | null>(null);
  const season = $derived(chosenSeason ?? view.next?.season ?? view.seasons[0]?.number ?? null);
  const episodes = $derived(view.seasons.find((entry) => entry.number === season)?.episodes ?? []);

  /** A movie is one unit with no seasons; its menu sits by the play button. */
  const movie = $derived(view.seasons.length === 0 && view.units.length === 1 ? view.units[0]! : null);
  const seasonUnits = $derived(episodes.filter((episode) => episode.playable));
  const seasonWatched = $derived(
    seasonUnits.every((episode) => episode.progress?.watched) ? true : seasonUnits.some((episode) => episode.progress?.watched) ? null : false,
  );
  let actionError = $state<string | null>(null);

  const canForget = (unit: UnitSummary) => !!unit.progress && !unit.progress.completed && unit.progress.positionSeconds > 0;

  /** Runs a watched-state change, then reloads the page's data so ticks, progress and "play" update. */
  async function apply(units: readonly UnitSummary[], action: "watched" | "unwatched" | "forget") {
    actionError = null;
    try {
      if (action === "forget") await Promise.all(units.map((unit) => forgetPosition(unit.id)));
      else await setWatched(units.map((unit) => unit.id), action === "watched");
      await invalidateAll();
    } catch (cause) {
      actionError = (cause as Error).message;
    }
  }

  function playLabel(next: UnitSummary): string {
    const code = episodeCode(next);
    if (next.progress && !next.progress.completed && next.progress.positionSeconds > 0) {
      return `Resume ${code}`.trim() + ` from ${formatTime(next.progress.positionSeconds)}`;
    }
    return `Play ${code}`.trim();
  }
</script>

<svelte:head>
  <title>{title.title} · TessaTV</title>
</svelte:head>

<div
  class="hero rounded-box -mx-4 -mt-4 mb-6 bg-cover bg-center"
  style:background-image={title.backdropUrl ? `url("${title.backdropUrl}")` : "none"}
>
  <div class="hero-overlay bg-base-100/80"></div>
  <div class="hero-content w-full flex-col items-start justify-start p-6 sm:flex-row">
    {#if title.posterUrl}<img src={title.posterUrl} alt="" class="rounded-box w-32 shadow-lg sm:w-48" />{/if}
    <div>
      <h1 class="text-3xl font-bold">{title.title}</h1>
      {#if title.year}<div class="opacity-70">{title.year}</div>{/if}
      {#if title.overview}<p class="max-w-2xl py-4 leading-relaxed">{title.overview}</p>{/if}
      <div class="flex items-center gap-2">
        {#if view.next}
          <a class="btn btn-warning" href="/watch/{view.next.id}"><Icon name="play" /> {playLabel(view.next)}</a>
        {:else if view.units.length > 0 && !movie?.progress?.watched}
          <span class="opacity-60">Nothing playable yet.</span>
        {/if}
        {#if movie?.playable}
          {#if movie.progress?.watched}<span class="text-warning" title="Watched"><Icon name="check" /></span>{/if}
          <WatchedMenu
            label={title.title}
            watched={movie.progress?.watched ?? false}
            canForget={canForget(movie)}
            onpick={(action) => apply([movie], action)}
          />
        {/if}
      </div>
      {#if actionError}<div class="alert alert-error mt-3">{actionError}</div>{/if}
    </div>
  </div>
</div>

{#if view.seasons.length > 0}
  <div class="mb-4 flex items-start gap-2">
  <div role="tablist" class="tabs tabs-box flex-1 flex-wrap">
    {#each view.seasons as entry (entry.number)}
      <button
        type="button"
        role="tab"
        class="tab"
        class:tab-active={entry.number === season}
        onclick={() => (chosenSeason = entry.number)}
      >
        {entry.number === 0 ? "Specials" : `Season ${entry.number}`}
      </button>
    {/each}
  </div>
    {#if seasonUnits.length > 0}
      <WatchedMenu
        label={season === 0 ? "Specials" : `Season ${season}`}
        watched={seasonWatched}
        onpick={(action) => apply(seasonUnits, action)}
      />
    {/if}
  </div>

  <ul class="list bg-base-200 rounded-box">
    {#each episodes as episode (episode.id)}
      <li class="list-row items-center" class:opacity-60={!episode.playable}>
        <span class="w-8 text-right tabular-nums opacity-60">{episode.episode ?? ""}</span>
        <div class="list-col-grow">
          {#if episode.playable}
            <a class="link link-hover" class:opacity-70={episode.progress?.watched} href="/watch/{episode.id}">{episode.title}</a>
          {:else}
            {episode.title} <span class="badge badge-ghost badge-sm">missing</span>
          {/if}
          {#if progressFraction(episode.progress) > 0}
            <progress class="progress progress-warning mt-1 block h-1" value={progressFraction(episode.progress)} max="1"></progress>
          {/if}
        </div>
        {#if episode.progress?.watched}<span class="text-warning" title="Watched"><Icon name="check" /></span>{/if}
        {#if episode.playable}
          <WatchedMenu
            label={episode.title}
            watched={episode.progress?.watched ?? false}
            canForget={canForget(episode)}
            onpick={(action) => apply([episode], action)}
          />
        {/if}
      </li>
    {/each}
  </ul>
{/if}
