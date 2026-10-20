<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types.js";

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    await invalidateAll();
    await goto("/login");
  }
</script>

<svelte:head>
  <title>TessaTV</title>
</svelte:head>

{#if data.session.user}
  <header>
    <strong>TessaTV</strong>
    <span>
      {data.session.user.username}
      <button type="button" onclick={logout}>Log out</button>
    </span>
  </header>
{/if}

<main>
  {@render children()}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
    background: #111;
    color: #eee;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #333;
  }
  main {
    padding: 1rem;
    max-width: 60rem;
    margin: 0 auto;
  }
  button {
    margin-left: 0.5rem;
  }
</style>
