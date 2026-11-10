<script lang="ts">
  let {
    href,
    title,
    subtitle = "",
    imageUrl,
    progress = 0,
    wide = false,
  }: { href: string; title: string; subtitle?: string; imageUrl: string | null; progress?: number; wide?: boolean } =
    $props();
</script>

<a class="group block flex-none {wide ? 'w-64' : 'w-36 sm:w-40'}" {href}>
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
