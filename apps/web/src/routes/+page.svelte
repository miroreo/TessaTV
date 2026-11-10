<script lang="ts">
  import type { WatchEntrySummary } from "@tessatv/domain";
  import { episodeCode, progressFraction } from "$lib/api.js";
  import PosterCard from "$lib/PosterCard.svelte";
  import Shelf from "$lib/Shelf.svelte";
  import type { PageData } from "./$types.js";

  let { data }: { data: PageData } = $props();
  const home = $derived(data.home);

  function entrySubtitle(entry: WatchEntrySummary): string {
    const code = episodeCode(entry.unit);
    return code ? `${code} · ${entry.unit.title}` : "";
  }
</script>

{#if home.continueWatching.length > 0}
  <Shelf heading="Continue watching">
    {#each home.continueWatching as entry (entry.unit.id)}
      <PosterCard
        wide
        href="/watch/{entry.unit.id}"
        title={entry.title.title}
        subtitle={entrySubtitle(entry)}
        imageUrl={entry.title.backdropUrl ?? entry.title.posterUrl}
        progress={progressFraction(entry.unit.progress)}
      />
    {/each}
  </Shelf>
{/if}

{#if home.nextUp.length > 0}
  <Shelf heading="Next up">
    {#each home.nextUp as entry (entry.unit.id)}
      <PosterCard
        wide
        href="/watch/{entry.unit.id}"
        title={entry.title.title}
        subtitle={entrySubtitle(entry)}
        imageUrl={entry.title.backdropUrl ?? entry.title.posterUrl}
      />
    {/each}
  </Shelf>
{/if}

{#if home.shows.length > 0}
  <Shelf heading="Shows" wrap>
    {#each home.shows as show (show.id)}
      <PosterCard href="/title/{show.id}" title={show.title} subtitle={show.year ? String(show.year) : ""} imageUrl={show.posterUrl} />
    {/each}
  </Shelf>
{/if}

{#if home.movies.length > 0}
  <Shelf heading="Movies" wrap>
    {#each home.movies as movie (movie.id)}
      <PosterCard href="/title/{movie.id}" title={movie.title} subtitle={movie.year ? String(movie.year) : ""} imageUrl={movie.posterUrl} />
    {/each}
  </Shelf>
{/if}

{#if home.shows.length === 0 && home.movies.length === 0}
  <div class="alert">Your library is empty. Import media with <code>POST /api/library/import</code>.</div>
{/if}
