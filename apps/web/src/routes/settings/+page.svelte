<script lang="ts">
  import type { LibraryFolderSummary, LibraryScanStatus } from "@tessatv/domain";
  import { invalidateAll } from "$app/navigation";
  import { api } from "$lib/api.js";
  import Icon from "$lib/Icon.svelte";
  import { onDestroy } from "svelte";
  import type { PageData } from "./$types.js";

  let { data }: { data: PageData } = $props();

  let mediaType = $state<"movie" | "series">("series");
  let path = $state("");
  let adding = $state(false);
  let error = $state<string | null>(null);
  /** Polled locally while a scan runs, so the page reflects it without reloading. */
  let liveScan = $state<LibraryScanStatus | null>(null);
  const scan = $derived(liveScan ?? data.scan);
  let poll: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(poll));

  const TYPE_LABEL = { movie: "Movies", series: "Shows" } as const;

  async function addFolder(event: SubmitEvent) {
    event.preventDefault();
    adding = true;
    error = null;
    try {
      await api<LibraryFolderSummary>(fetch, "/api/library/folders", { method: "POST", body: JSON.stringify({ mediaType, path }) });
      path = "";
      await invalidateAll();
      watchScan(); // adding a folder starts a scan
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      adding = false;
    }
  }

  async function removeFolder(folder: LibraryFolderSummary) {
    if (!confirm(`Stop scanning ${folder.path}? What's already in the library stays.`)) return;
    await api<void>(fetch, `/api/library/folders/${folder.id}`, { method: "DELETE" });
    await invalidateAll();
  }

  async function scanNow() {
    liveScan = await api<LibraryScanStatus>(fetch, "/api/library/scan", { method: "POST" });
    watchScan();
  }

  function watchScan() {
    clearTimeout(poll);
    poll = setTimeout(async () => {
      liveScan = await api<LibraryScanStatus>(fetch, "/api/library/scan");
      if (liveScan.running) watchScan();
      else await invalidateAll();
    }, 1500);
  }

  function when(iso: string): string {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
</script>

<svelte:head>
  <title>Settings · TessaTV</title>
</svelte:head>

<h1 class="mb-6 text-2xl font-bold">Settings</h1>

<section class="card bg-base-200 mb-6">
  <div class="card-body">
    <h2 class="card-title">Library folders</h2>
    <p class="text-sm opacity-70">
      Scanned every 15 minutes for new files. Use paths as the server sees them — under Docker, that's inside the
      container (the <code>MEDIA_ROOT</code> mount keeps them identical to the host's).
    </p>

    {#if data.folders.length === 0}
      <div class="alert">No folders yet — add your movies and shows folders below.</div>
    {:else}
      <ul class="list">
        {#each data.folders as folder (folder.id)}
          <li class="list-row items-center">
            <Icon name="folder" class="size-5 opacity-60" />
            <div class="list-col-grow min-w-0">
              <div class="truncate font-mono text-sm">{folder.path}</div>
              <div class="mt-1 flex gap-2">
                <span class="badge badge-sm badge-ghost">{TYPE_LABEL[folder.mediaType]}</span>
                {#if !folder.reachable}
                  <span class="badge badge-sm badge-warning"><Icon name="warning" class="size-3" /> Can't read this folder right now</span>
                {/if}
              </div>
            </div>
            <button type="button" class="btn btn-ghost btn-sm btn-circle" onclick={() => removeFolder(folder)} aria-label="Remove {folder.path}" title="Remove">
              <Icon name="remove" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <form class="mt-2 flex flex-wrap items-end gap-2" onsubmit={addFolder}>
      <select class="select w-auto" bind:value={mediaType} aria-label="Folder type">
        <option value="series">Shows</option>
        <option value="movie">Movies</option>
      </select>
      <input class="input min-w-64 flex-1 font-mono" placeholder="/media/shows" bind:value={path} aria-label="Folder path" required />
      <button type="submit" class="btn btn-warning" disabled={adding || !path.trim()}>
        {#if adding}<span class="loading loading-spinner loading-sm"></span>{:else}<Icon name="add" />{/if} Add folder
      </button>
    </form>
    {#if error}<div class="alert alert-error mt-2">{error}</div>{/if}
  </div>
</section>

<section class="card bg-base-200">
  <div class="card-body">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="card-title">Library scan</h2>
      <button type="button" class="btn btn-sm" onclick={scanNow} disabled={scan.running || data.folders.length === 0}>
        {#if scan.running}<span class="loading loading-spinner loading-sm"></span> Scanning…{:else}<Icon name="rescan" /> Scan now{/if}
      </button>
    </div>
    <p class="text-sm opacity-70">
      Adds new files, identifies them, and hides titles whose files have disappeared. Hidden titles keep their watch history
      and come back when their files do. A folder that can't be read is skipped, never treated as deleted.
    </p>

    {#if scan.lastScan}
      {@const last = scan.lastScan}
      <div class="text-sm">Last scan: {when(last.finishedAt)}</div>
      {#if last.error}
        <div class="alert alert-error">Scan failed: {last.error}</div>
      {:else}
        <div class="stats stats-vertical sm:stats-horizontal bg-base-100">
          <div class="stat"><div class="stat-title">Episodes added</div><div class="stat-value text-2xl">{last.episodesAdded}</div></div>
          <div class="stat"><div class="stat-title">Movies added</div><div class="stat-value text-2xl">{last.moviesAdded}</div></div>
          <div class="stat"><div class="stat-title">Now missing</div><div class="stat-value text-2xl">{last.markedMissing}</div></div>
          <div class="stat"><div class="stat-title">Back again</div><div class="stat-value text-2xl">{last.restored}</div></div>
        </div>
      {/if}
      {#if last.skippedFolders.length > 0}
        <details class="collapse collapse-arrow bg-base-100">
          <summary class="collapse-title text-sm">{last.skippedFolders.length} skipped</summary>
          <ul class="collapse-content text-sm">
            {#each last.skippedFolders as skipped (skipped.path)}
              <li><span class="font-mono">{skipped.path}</span> — {skipped.reason}</li>
            {/each}
          </ul>
        </details>
      {/if}
    {:else if !scan.running}
      <div class="text-sm opacity-70">No scan has run since the server started.</div>
    {/if}
  </div>
</section>
