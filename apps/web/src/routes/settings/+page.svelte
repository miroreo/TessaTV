<script lang="ts">
  import {
    MAX_STREAM_HEIGHTS,
    type FileHealthStatusResponse,
    type JellyfinImportResponse,
    type LibraryFolderSummary,
    type LibraryScanStatus,
    type MaxStreamHeight,
    type OidcSettingsInput,
    type ServerSettingsResponse,
  } from "@tessatv/domain";
  import { invalidateAll } from "$app/navigation";
  // Not `window`: this page is also rendered on the server.
  import { page } from "$app/state";
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

  /** The background decode check: refreshed here every few seconds while the page is open. */
  let liveHealth = $state<FileHealthStatusResponse | null>(null);
  const health = $derived(liveHealth ?? data.fileHealth);
  let savingHealth = $state(false);
  let healthError = $state<string | null>(null);
  // Quicker while a file is being decoded, so its progress moves.
  const healthPollMs = $derived(health.current ? 3_000 : 10_000);
  $effect(() => {
    const timer = setInterval(async () => {
      try {
        liveHealth = await api<FileHealthStatusResponse>(fetch, "/api/file-health");
      } catch {
        // A missed refresh just shows the previous numbers.
      }
    }, healthPollMs);
    return () => clearInterval(timer);
  });

  function clock(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    const [h, m, s] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
    return `${h > 0 ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s).padStart(2, "0")}`;
  }
  const healthPercent = $derived(
    health.current?.durationSeconds ? Math.min(100, (health.current.positionSeconds / health.current.durationSeconds) * 100) : null,
  );

  const HEALTH_STATE_LABEL: Record<FileHealthStatusResponse["state"], string> = {
    disabled: "Off",
    waiting: "Paused while a video is transcoding",
    checking: "Checking",
    idle: "Everything is checked",
  };

  async function setFileHealthCheck(event: Event) {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    savingHealth = true;
    healthError = null;
    try {
      await api<ServerSettingsResponse>(fetch, "/api/settings", { method: "PATCH", body: JSON.stringify({ fileHealthCheck: enabled }) });
      liveHealth = await api<FileHealthStatusResponse>(fetch, "/api/file-health");
    } catch (cause) {
      healthError = (cause as Error).message;
    } finally {
      savingHealth = false;
    }
  }

  let maxStreamHeight = $state<MaxStreamHeight | null>(null);
  let savingSettings = $state(false);
  let settingsSaved = $state(false);
  let settingsError = $state<string | null>(null);
  $effect.pre(() => {
    maxStreamHeight = data.settings.maxStreamHeight as MaxStreamHeight | null;
  });

  const HEIGHT_LABEL: Record<MaxStreamHeight, string> = { 2160: "4K (2160p)", 1440: "1440p", 1080: "1080p", 720: "720p", 480: "480p" };

  async function saveMaxStreamHeight(event: Event) {
    (event.currentTarget as HTMLElement).blur();
    savingSettings = true;
    settingsSaved = false;
    settingsError = null;
    try {
      const saved = await api<ServerSettingsResponse>(fetch, "/api/settings", { method: "PATCH", body: JSON.stringify({ maxStreamHeight }) });
      maxStreamHeight = saved.maxStreamHeight as MaxStreamHeight | null;
      settingsSaved = true;
    } catch (cause) {
      settingsError = (cause as Error).message;
    } finally {
      savingSettings = false;
    }
  }

  /** The SSO form, starting from what's saved (the secret is never sent back, only whether one is set). */
  const savedOidc = $derived(data.settings.oidc);
  let sso = $state({
    enabled: false,
    publicUrl: "",
    issuerUrl: "",
    clientId: "",
    clientSecret: "",
    adminGroup: "",
    requiredGroup: "",
    buttonLabel: "Sign in with Authentik",
  });
  $effect.pre(() => {
    const saved = savedOidc;
    sso = {
      enabled: saved?.enabled ?? false,
      publicUrl: saved?.publicUrl ?? page.url.origin,
      issuerUrl: saved?.issuerUrl ?? "",
      clientId: saved?.clientId ?? "",
      clientSecret: "",
      adminGroup: saved?.adminGroup ?? "",
      requiredGroup: saved?.requiredGroup ?? "",
      buttonLabel: saved?.buttonLabel ?? "Sign in with Authentik",
    };
  });
  const callbackUrl = $derived(`${sso.publicUrl.replace(/\/+$/, "") || page.url.origin}/api/auth/oidc/callback`);
  let savingSso = $state(false);
  let ssoMessage = $state<{ ok: boolean; text: string } | null>(null);

  async function saveSso(event: SubmitEvent) {
    event.preventDefault();
    savingSso = true;
    ssoMessage = null;
    const oidc: OidcSettingsInput = {
      enabled: sso.enabled,
      publicUrl: sso.publicUrl,
      issuerUrl: sso.issuerUrl,
      clientId: sso.clientId,
      ...(sso.clientSecret ? { clientSecret: sso.clientSecret } : {}),
      adminGroup: sso.adminGroup || null,
      requiredGroup: sso.requiredGroup || null,
      buttonLabel: sso.buttonLabel,
    };
    try {
      await api<ServerSettingsResponse>(fetch, "/api/settings", { method: "PATCH", body: JSON.stringify({ oidc }) });
      await invalidateAll();
      ssoMessage = { ok: true, text: sso.enabled ? "Saved. The login page now offers single sign-on." : "Saved (single sign-on is off)." };
    } catch (cause) {
      ssoMessage = { ok: false, text: (cause as Error).message };
    } finally {
      savingSso = false;
    }
  }

  /** Watch history import: the Jellyfin address and API key, then a run that reports per person. */
  const savedJellyfin = $derived(data.settings.jellyfin);
  let jellyfin = $state({ url: "", apiKey: "" });
  $effect.pre(() => {
    jellyfin = { url: savedJellyfin?.url ?? "", apiKey: "" };
  });
  let savingJellyfin = $state(false);
  let importing = $state(false);
  let jellyfinMessage = $state<{ ok: boolean; text: string } | null>(null);
  let importReport = $state<JellyfinImportResponse | null>(null);

  async function saveJellyfin(event: SubmitEvent) {
    event.preventDefault();
    savingJellyfin = true;
    jellyfinMessage = null;
    try {
      await api<ServerSettingsResponse>(fetch, "/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ jellyfin: { url: jellyfin.url, ...(jellyfin.apiKey ? { apiKey: jellyfin.apiKey } : {}) } }),
      });
      await invalidateAll();
      jellyfinMessage = { ok: true, text: "Connected and saved." };
    } catch (cause) {
      jellyfinMessage = { ok: false, text: (cause as Error).message };
    } finally {
      savingJellyfin = false;
    }
  }

  async function runImport() {
    importing = true;
    jellyfinMessage = null;
    importReport = null;
    try {
      importReport = await api<JellyfinImportResponse>(fetch, "/api/jellyfin/import", { method: "POST" });
    } catch (cause) {
      jellyfinMessage = { ok: false, text: (cause as Error).message };
    } finally {
      importing = false;
    }
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
    <h2 class="card-title">Playback</h2>
    <label class="flex flex-wrap items-center gap-3">
      <span>Maximum resolution</span>
      <select class="select w-auto" bind:value={maxStreamHeight} onchange={saveMaxStreamHeight} disabled={savingSettings} aria-label="Maximum resolution">
        <option value={null}>Original (no limit)</option>
        {#each MAX_STREAM_HEIGHTS as height (height)}
          <option value={height}>{HEIGHT_LABEL[height]}</option>
        {/each}
      </select>
      {#if savingSettings}
        <span class="loading loading-spinner loading-sm"></span>
      {:else if settingsSaved}
        <span class="text-success flex items-center gap-1 text-sm"><Icon name="check" class="size-4" /> Saved</span>
      {/if}
    </label>
    <p class="text-sm opacity-70">
      No stream is sent taller than this, on any device. A taller file is transcoded down instead of played as-is — which also
      keeps 4K HDR files from transcoding at full size, the slowest thing this server does. Applies from the next time a video
      starts.
    </p>
    {#if settingsError}<div class="alert alert-error">{settingsError}</div>{/if}
  </div>
</section>

<section class="card bg-base-200 mb-6">
  <div class="card-body">
    <h2 class="card-title">File health check</h2>
    <p class="text-sm opacity-70">
      Slowly decodes every video file in the background, on the CPU at the lowest priority and only while nothing is transcoding,
      to find damaged files before anyone plays them. A damaged file is always transcoded on the CPU, never played directly.
      Each file is checked again every 90 days, or when it changes.
    </p>
    <label class="label cursor-pointer justify-start gap-3">
      <input type="checkbox" class="toggle toggle-warning" checked={health.enabled} onchange={setFileHealthCheck} disabled={savingHealth} />
      <span class="text-base-content">Check files in the background</span>
      {#if savingHealth}<span class="loading loading-spinner loading-sm"></span>{/if}
    </label>
    {#if healthError}<div class="alert alert-error">{healthError}</div>{/if}
    <div class="stats stats-vertical sm:stats-horizontal bg-base-100 w-full">
      <div class="stat">
        <div class="stat-title">Checked</div>
        <div class="stat-value text-2xl">{health.clean + health.damaged} <span class="text-base font-normal opacity-70">of {health.total}</span></div>
        <div class="stat-desc">{health.due} waiting</div>
      </div>
      <div class="stat">
        <div class="stat-title">Damaged</div>
        <div class="stat-value text-2xl" class:text-error={health.damaged > 0}>{health.damaged}</div>
      </div>
      <div class="stat">
        <div class="stat-title">Status</div>
        <div class="stat-value text-lg">{HEALTH_STATE_LABEL[health.state]}</div>
      </div>
    </div>
    {#if health.current}
      <div class="bg-base-100 rounded-box space-y-2 p-4" aria-live="off">
        <div class="font-mono text-sm break-all">{health.current.path}</div>
        <progress class="progress progress-warning w-full" value={healthPercent ?? undefined} max="100"></progress>
        <div class="flex flex-wrap gap-x-4 text-sm opacity-80">
          <span>{healthPercent !== null ? `${healthPercent.toFixed(1)}%` : "length unknown"}</span>
          <span>
            {clock(health.current.positionSeconds)}{health.current.durationSeconds ? ` / ${clock(health.current.durationSeconds)}` : ""}
          </span>
          {#if health.current.fps !== null}<span>{health.current.fps.toFixed(0)} fps</span>{/if}
          {#if health.current.speed !== null}<span>{health.current.speed.toFixed(1)}× realtime</span>{/if}
        </div>
      </div>
    {/if}
    {#if health.damagedFiles.length > 0}
      <h3 class="mt-2 font-semibold">Damaged files</h3>
      <ul class="divide-base-300 divide-y text-sm">
        {#each health.damagedFiles as file (file.path)}
          <li class="py-2">
            <div class="font-mono break-all">{file.path}</div>
            <div class="text-error break-words opacity-90">{file.error}</div>
            <div class="text-xs opacity-60">checked {new Date(file.checkedAt).toLocaleString()}</div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<section class="card bg-base-200 mb-6">
  <div class="card-body">
    <h2 class="card-title">Single sign-on</h2>
    <p class="text-sm opacity-70">
      Sign in through an OpenID Connect provider such as Authentik. Anyone it lets through gets an account the first time they sign
      in; members of the admin group are admins. Your own password keeps working, so a provider problem can't lock you out.
    </p>
    <form class="grid gap-3 sm:grid-cols-2" onsubmit={saveSso}>
      <label class="label col-span-full cursor-pointer justify-start gap-3">
        <input type="checkbox" class="toggle toggle-warning" bind:checked={sso.enabled} />
        <span class="text-base-content">Offer single sign-on on the login page</span>
      </label>
      <label class="floating-label col-span-full">
        <span>TessaTV's address</span>
        <input class="input w-full font-mono" placeholder="https://tv.example.com" bind:value={sso.publicUrl} required />
      </label>
      <div class="col-span-full text-sm">
        Redirect URI to give your provider: <code class="bg-base-100 rounded px-1 break-all select-all">{callbackUrl}</code>
      </div>
      <label class="floating-label col-span-full">
        <span>Issuer URL</span>
        <input class="input w-full font-mono" placeholder="https://auth.example.com/application/o/tessatv/" bind:value={sso.issuerUrl} required />
      </label>
      <label class="floating-label">
        <span>Client ID</span>
        <input class="input w-full font-mono" bind:value={sso.clientId} required />
      </label>
      <label class="floating-label">
        <span>Client secret</span>
        <input
          class="input w-full font-mono"
          type="password"
          autocomplete="off"
          placeholder={savedOidc?.hasClientSecret ? "Saved — leave blank to keep" : ""}
          bind:value={sso.clientSecret}
          required={!savedOidc?.hasClientSecret}
        />
      </label>
      <label class="floating-label">
        <span>Admin group</span>
        <input class="input w-full" placeholder="tessatv-admins" bind:value={sso.adminGroup} />
      </label>
      <label class="floating-label">
        <span>Required group (optional)</span>
        <input class="input w-full" placeholder="Anyone the provider allows" bind:value={sso.requiredGroup} />
      </label>
      <label class="floating-label col-span-full">
        <span>Button text</span>
        <input class="input w-full" bind:value={sso.buttonLabel} required maxlength="60" />
      </label>
      <div class="col-span-full flex flex-wrap items-center gap-3">
        <button type="submit" class="btn btn-warning" disabled={savingSso}>
          {#if savingSso}<span class="loading loading-spinner loading-sm"></span>{/if} Save
        </button>
        {#if ssoMessage}
          <span class="text-sm" class:text-success={ssoMessage.ok} class:text-error={!ssoMessage.ok}>{ssoMessage.text}</span>
        {/if}
      </div>
    </form>
  </div>
</section>

<section class="card bg-base-200 mb-6">
  <div class="card-body">
    <h2 class="card-title">Import from Jellyfin</h2>
    <p class="text-sm opacity-70">
      Copies everyone's watched marks and resume positions from a Jellyfin server onto the TessaTV accounts with the same username.
      People who don't have an account yet get theirs the first time they sign in. It only adds to what's here — newer wins, nothing is
      removed — so it's safe to run again. Make an API key under Jellyfin's Dashboard → API Keys.
    </p>
    <form class="grid gap-3 sm:grid-cols-2" onsubmit={saveJellyfin}>
      <label class="floating-label">
        <span>Jellyfin address</span>
        <input class="input w-full font-mono" placeholder="http://jellyfin.lan:8096" bind:value={jellyfin.url} required />
      </label>
      <label class="floating-label">
        <span>API key</span>
        <input
          class="input w-full font-mono"
          type="password"
          autocomplete="off"
          placeholder={savedJellyfin?.hasApiKey ? "Saved — leave blank to keep" : ""}
          required={!savedJellyfin?.hasApiKey}
          bind:value={jellyfin.apiKey}
        />
      </label>
      <div class="col-span-full flex flex-wrap items-center gap-3">
        <button class="btn btn-warning" type="submit" disabled={savingJellyfin}>{savingJellyfin ? "Connecting…" : "Save"}</button>
        <button class="btn" type="button" onclick={runImport} disabled={importing || !savedJellyfin}>
          {importing ? "Importing…" : "Import watch history"}
        </button>
        {#if jellyfinMessage}
          <span class="text-sm {jellyfinMessage.ok ? 'text-success' : 'text-error'}">{jellyfinMessage.text}</span>
        {/if}
      </div>
    </form>
    {#if importReport}
      <ul class="list">
        {#each importReport.users as person (person.username)}
          <li class="list-row items-center">
            <div class="list-col-grow">{person.username}</div>
            <div class="text-sm opacity-70">
              {person.matched} matched{person.unmatched ? `, ${person.unmatched} not in this library` : ""}
            </div>
            <span class="badge badge-sm {person.outcome === 'imported' ? 'badge-success' : 'badge-ghost'}">
              {person.outcome === "imported" ? "Imported" : "Waiting for sign-in"}
            </span>
          </li>
        {:else}
          <li class="list-row text-sm opacity-70">That server has no users.</li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<section class="card bg-base-200 mb-6">
  <div class="card-body">
    <h2 class="card-title">Users</h2>
    <ul class="list">
      {#each data.users as user (user.id)}
        <li class="list-row items-center">
          <div class="list-col-grow">{user.username}</div>
          <div class="flex flex-wrap gap-1">
            {#if user.isAdmin}<span class="badge badge-sm badge-warning">Admin</span>{/if}
            {#if user.usesSso}<span class="badge badge-sm badge-ghost">SSO</span>{/if}
            {#if user.hasPassword}<span class="badge badge-sm badge-ghost">Password</span>{/if}
          </div>
        </li>
      {/each}
    </ul>
  </div>
</section>

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
          <div class="stat"><div class="stat-title">Files replaced</div><div class="stat-value text-2xl">{last.relinked}</div></div>
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
