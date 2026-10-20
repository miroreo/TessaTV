<script lang="ts">
  import type { PageData } from "./$types.js";

  let { data }: { data: PageData } = $props();
</script>

<h1>Library</h1>

{#if data.items.length === 0}
  <p>No library items yet.</p>
{:else}
  <ul>
    {#each data.items as item (item.id)}
      <li>{item.title} <small>({item.mediaType})</small></li>
    {/each}
  </ul>
{/if}
