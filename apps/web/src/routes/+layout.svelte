<script lang="ts">
  import "../app.css";
  import { goto, invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import Icon from "$lib/Icon.svelte";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types.js";

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
  // The player takes over the whole window.
  const chromeless = $derived(page.url.pathname.startsWith("/watch/"));

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    await invalidateAll();
    await goto("/login");
  }
</script>

<svelte:head>
  <title>TessaTV</title>
</svelte:head>

{#if data.session.user && !chromeless}
  <header class="navbar bg-base-200 px-4">
    <a href="/" class="flex-1 text-xl font-bold">TessaTV</a>
    <div class="flex items-center gap-2">
      {#if data.session.user.isAdmin}
        <a href="/settings" class="btn btn-ghost btn-sm" aria-label="Settings" title="Settings"><Icon name="settings" /></a>
      {/if}
      <span class="text-sm opacity-70">{data.session.user.username}</span>
      <button type="button" class="btn btn-ghost btn-sm" onclick={logout}>Log out</button>
    </div>
  </header>
{/if}

{#if chromeless}
  {@render children()}
{:else}
  <main class="mx-auto max-w-7xl p-4">
    {@render children()}
  </main>
{/if}
