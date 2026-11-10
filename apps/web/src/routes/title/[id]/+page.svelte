<script lang="ts">
  import type { UnitSummary } from "@tessatv/domain";
  import { episodeCode, formatTime, progressFraction } from "$lib/api.js";
  import Icon from "$lib/Icon.svelte";
  import type { PageData } from "./$types.js";

  let { data }: { data: PageData } = $props();
  const view = $derived(data.view);
  const title = $derived(view.title);

  // Opens on the season of whatever "play" would start.
  let chosenSeason = $state<number | null>(null);
  const season = $derived(chosenSeason ?? view.next?.season ?? view.seasons[0]?.number ?? null);
  const episodes = $derived(view.seasons.find((entry) => entry.number === season)?.episodes ?? []);

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
      {#if view.next}
        <a class="btn btn-warning" href="/watch/{view.next.id}"><Icon name="play" /> {playLabel(view.next)}</a>
      {:else if view.units.length > 0}
        <span class="opacity-60">Nothing playable yet.</span>
      {/if}
    </div>
  </div>
</div>

{#if view.seasons.length > 0}
  <div role="tablist" class="tabs tabs-box mb-4 flex-wrap">
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

  <ul class="list bg-base-200 rounded-box">
    {#each episodes as episode (episode.id)}
      <li class="list-row items-center" class:opacity-60={!episode.playable}>
        <span class="w-8 text-right tabular-nums opacity-60">{episode.episode ?? ""}</span>
        <div class="list-col-grow">
          {#if episode.playable}
            <a class="link link-hover" class:opacity-70={episode.progress?.completed} href="/watch/{episode.id}">{episode.title}</a>
          {:else}
            {episode.title} <span class="badge badge-ghost badge-sm">missing</span>
          {/if}
          {#if progressFraction(episode.progress) > 0}
            <progress class="progress progress-warning mt-1 block h-1" value={progressFraction(episode.progress)} max="1"></progress>
          {/if}
        </div>
        {#if episode.progress?.completed}<span class="text-warning" title="Watched"><Icon name="check" /></span>{/if}
      </li>
    {/each}
  </ul>
{/if}
