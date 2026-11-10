<script lang="ts">
  import Player from "$lib/Player.svelte";
  import type { PageData } from "./$types.js";

  let { data }: { data: PageData } = $props();
</script>

<!--
  SvelteKit reuses a page component when only its params change, so without the key, going
  to the next episode kept the previous episode's player alive (its video, timers and
  transcode) under the new episode's data.
-->
{#key data.info.unit.id}
  <Player info={data.info} />
{/key}
