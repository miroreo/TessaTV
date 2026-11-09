<script lang="ts">
  import type { PageData } from "./$types.js";

  let { data }: { data: PageData } = $props();
</script>

<h1 class="mb-4 text-2xl font-bold">Library</h1>

{#if data.items.length === 0}
  <div class="alert">No library items yet.</div>
{:else}
  <ul class="list bg-base-200 rounded-box">
    {#each data.items as item (item.id)}
      <li class="list-row items-center">
        <span>{item.title}</span>
        <span class="badge badge-ghost badge-sm">{item.mediaType}</span>
      </li>
    {/each}
  </ul>
{/if}
