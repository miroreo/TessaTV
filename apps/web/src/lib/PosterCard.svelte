<script lang="ts">
  import Icon from "$lib/Icon.svelte";

  let {
    href,
    title,
    subtitle = "",
    imageUrl,
    progress = 0,
    wide = false,
    onremove,
    removeLabel = "Remove",
  }: {
    href: string;
    title: string;
    subtitle?: string;
    imageUrl: string | null;
    progress?: number;
    wide?: boolean;
    /** Shows a small "×" on the card (on hover, or always on touch screens). */
    onremove?: () => void;
    removeLabel?: string;
  } = $props();
</script>

<div class="group relative flex-none {wide ? 'w-64' : 'w-36 sm:w-40'}">
  <a class="block" {href}>
    <figure class="bg-base-300 rounded-box relative grid place-items-center overflow-hidden {wide ? 'aspect-video' : 'aspect-[2/3]'}">
      {#if imageUrl}
        <img src={imageUrl} alt="" loading="lazy" class="size-full object-cover transition-opacity group-hover:opacity-80" />
      {:else}
        <span class="p-2 text-center text-sm opacity-60">{title}</span>
      {/if}
      {#if progress > 0}
        <progress class="progress progress-warning absolute inset-x-0 bottom-0 h-1 rounded-none" value={progress} max="1"></progress>
      {/if}
    </figure>
    <div class="mt-2 truncate text-sm">{title}</div>
    {#if subtitle}<div class="truncate text-xs opacity-60">{subtitle}</div>{/if}
  </a>
  {#if onremove}
    <!-- Beside the link, not in it: a button inside a link is invalid and would also navigate. -->
    <button
      type="button"
      class="btn btn-circle btn-xs absolute top-1 right-1 bg-black/70 opacity-100 group-hover:opacity-100 focus:opacity-100 sm:opacity-0"
      onclick={onremove}
      aria-label="{removeLabel}: {title}"
      title={removeLabel}
    >
      <Icon name="close" class="size-3" />
    </button>
  {/if}
</div>
