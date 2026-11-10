<script lang="ts">
  import Player from "$lib/Player.svelte";
  import { onDestroy } from "svelte";
  import type { PageData } from "./$types.js";

  let { data }: { data: PageData } = $props();

  // Only leaving the watch page ends here; moving to another episode keeps this component
  // (and fullscreen, which the player puts on the whole page) alive.
  onDestroy(() => {
    if (typeof document !== "undefined" && document.fullscreenElement) void document.exitFullscreen();
  });
</script>

<!--
  SvelteKit reuses a page component when only its params change, so without the key, going
  to the next episode kept the previous episode's player alive (its video, timers and
  transcode) under the new episode's data.
-->
{#key data.info.unit.id}
  <Player info={data.info} isAdmin={data.session.user?.isAdmin ?? false} />
{/key}
