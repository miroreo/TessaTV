<script lang="ts">
  import type { Snippet } from "svelte";

  let { heading, children, wrap = false }: { heading: string; children: Snippet; wrap?: boolean } = $props();
</script>

<section class="mb-8">
  <h2 class="mb-3 text-lg font-semibold">{heading}</h2>
  <div class="flex gap-4 {wrap ? 'flex-wrap' : 'overflow-x-auto pb-2'}">
    {@render children()}
  </div>
</section>
