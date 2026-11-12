<script lang="ts">
  import type { IdentifyCandidatesResponse } from "@tessatv/domain";
  import { api } from "$lib/api.js";
  import Icon from "$lib/Icon.svelte";

  /**
   * Lists provider matches (poster, title, year) for a movie or series next to the folder name
   * it was scanned from, and applies the one the user picks. Opens searching by that folder
   * name; the box lets the user search for something else when it's a poor guess.
   */
  let { nodeId, oncomplete }: { nodeId: string; oncomplete: () => Promise<void> | void } = $props();

  let dialog: HTMLDialogElement;
  let result = $state<IdentifyCandidatesResponse | null>(null);
  let typed = $state("");
  let loading = $state(false);
  let applying = $state<string | null>(null);
  let error = $state<string | null>(null);

  async function search(query?: string) {
    loading = true;
    error = null;
    try {
      const params = query ? `?query=${encodeURIComponent(query)}` : "";
      result = await api<IdentifyCandidatesResponse>(fetch, `/api/library/${nodeId}/metadata/candidates${params}`);
      typed = result.query;
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      loading = false;
    }
  }

  export function open() {
    dialog.showModal();
    if (!result) void search();
  }

  async function pick(externalId: string) {
    applying = externalId;
    error = null;
    try {
      await api(fetch, `/api/library/${nodeId}/metadata/identify`, {
        method: "POST",
        body: JSON.stringify({ externalId, provider: result?.provider }),
      });
      dialog.close();
      result = null;
      await oncomplete();
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      applying = null;
    }
  }
</script>

<dialog class="modal" bind:this={dialog}>
  <div class="modal-box max-w-2xl">
    <form method="dialog">
      <button class="btn btn-ghost btn-circle btn-sm absolute top-3 right-3" aria-label="Close"><Icon name="close" /></button>
    </form>
    <h2 class="text-lg font-bold">Fix match</h2>
    {#if result}
      <p class="py-1 text-sm opacity-70">Scanned as <code class="break-all">{result.source}</code></p>
    {/if}

    <form
      class="join my-3 flex"
      onsubmit={(event) => {
        event.preventDefault();
        void search(typed.trim() || undefined);
      }}
    >
      <input class="input input-bordered join-item flex-1" bind:value={typed} placeholder="Search by title" aria-label="Search by title" />
      <button class="btn btn-primary join-item" disabled={loading}><Icon name="search" /> Search</button>
    </form>

    {#if error}<div class="alert alert-error mb-3">{error}</div>{/if}
    {#if loading}
      <div class="flex justify-center py-8"><span class="loading loading-spinner"></span></div>
    {:else if result}
      {#if result.items.length === 0}
        <p class="py-6 text-center opacity-70">No matches. Try a different search.</p>
      {:else}
        <ul class="list bg-base-200 rounded-box">
          {#each result.items as item (item.externalId)}
            <li class="list-row items-start">
              {#if item.posterUrl}
                <img src={item.posterUrl} alt="" class="rounded-box h-24 w-16 object-cover" loading="lazy" />
              {:else}
                <div class="bg-base-300 rounded-box h-24 w-16"></div>
              {/if}
              <div class="list-col-grow min-w-0">
                <div class="font-semibold">{item.title}{#if item.year} <span class="font-normal opacity-60">({item.year})</span>{/if}</div>
                {#if item.overview}<p class="line-clamp-3 text-sm opacity-70">{item.overview}</p>{/if}
              </div>
              <button type="button" class="btn btn-primary btn-sm" disabled={applying !== null} onclick={() => pick(item.externalId)}>
                {#if applying === item.externalId}<span class="loading loading-spinner loading-xs"></span>{:else}Select{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
  <form method="dialog" class="modal-backdrop"><button aria-label="Close">close</button></form>
</dialog>
