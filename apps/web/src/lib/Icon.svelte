<script lang="ts">
  import { icons, type IconName } from "./icons.js";

  let { name, class: className = "size-5" }: { name: IconName; class?: string } = $props();
</script>

<!-- Static, bundled SVG markup from the heroicons package — never user input. -->
<span class="inline-block shrink-0 [&>svg]:size-full {className}" aria-hidden="true">{@html icons[name]}</span>
