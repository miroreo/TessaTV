<script lang="ts">
  import Icon from "$lib/Icon.svelte";

  /**
   * A "⋮" menu of watched-state actions. Each action is offered only when it would change
   * something; `onpick` runs it, and the menu closes either way.
   */
  let {
    label,
    watched,
    canForget = false,
    onpick,
  }: {
    /** For screen readers: what the menu is about, e.g. "Episode 3". */
    label: string;
    /** Null offers both "mark watched" and "mark unwatched" (e.g. a season with some of each). */
    watched: boolean | null;
    canForget?: boolean;
    onpick: (action: "watched" | "unwatched" | "forget") => Promise<void>;
  } = $props();

  let menu: HTMLDetailsElement;
  let busy = $state(false);

  async function pick(action: "watched" | "unwatched" | "forget") {
    menu.open = false;
    busy = true;
    try {
      await onpick(action);
    } finally {
      busy = false;
    }
  }
</script>

<details class="dropdown dropdown-end" bind:this={menu}>
  <summary class="btn btn-ghost btn-circle btn-sm" aria-label="More for {label}" title="More">
    {#if busy}<span class="loading loading-spinner loading-xs"></span>{:else}<Icon name="menu" />{/if}
  </summary>
  <ul class="dropdown-content menu bg-base-300 rounded-box z-10 w-56 p-2 shadow">
    {#if watched !== true}
      <li><button type="button" onclick={() => pick("watched")}><Icon name="markWatched" class="size-4" /> Mark as watched</button></li>
    {/if}
    {#if watched !== false}
      <li><button type="button" onclick={() => pick("unwatched")}><Icon name="markUnwatched" class="size-4" /> Mark as unwatched</button></li>
    {/if}
    {#if canForget}
      <li><button type="button" onclick={() => pick("forget")}><Icon name="restart" class="size-4" /> Start from the beginning</button></li>
    {/if}
  </ul>
</details>
