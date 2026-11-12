<script lang="ts">
  import { ApiError, api } from "$lib/api.js";
  import type { PairingPollResponse, PairingResponse } from "@tessatv/domain";
  import { onDestroy } from "svelte";

  let { onapproved }: { onapproved: () => void } = $props();

  const POLL_MS = 2000;
  let pairing = $state<PairingResponse | null>(null);
  let error = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function stop() {
    clearTimeout(timer);
    timer = undefined;
  }

  async function poll(current: PairingResponse) {
    try {
      const { status } = await api<PairingPollResponse>(fetch, "/api/auth/pairing/poll", {
        method: "POST",
        body: JSON.stringify({ secret: current.secret }),
      });
      if (status === "approved") return onapproved();
    } catch (cause) {
      // Expired (or gone): stop asking and let them request a new code.
      if (cause instanceof ApiError && cause.status === 404) {
        pairing = null;
        error = "That code expired.";
        return;
      }
    }
    timer = setTimeout(() => poll(current), POLL_MS);
  }

  async function start() {
    stop();
    error = null;
    try {
      pairing = await api<PairingResponse>(fetch, "/api/auth/pairing", { method: "POST" });
      timer = setTimeout(() => poll(pairing!), POLL_MS);
    } catch {
      error = "Couldn't get a code. Try again.";
    }
  }

  onDestroy(stop);
</script>

{#if pairing}
  <div class="flex w-full flex-col items-center gap-2 text-center">
    <div class="font-mono text-5xl tracking-widest" aria-live="polite">{pairing.code}</div>
    <p class="text-sm opacity-70">
      On a device where you're signed in to TessaTV, open <strong>Sign in a TV</strong> and enter this code.
    </p>
    <span class="loading loading-dots loading-sm"></span>
    <button type="button" class="btn btn-ghost btn-sm" onclick={start}>New code</button>
  </div>
{:else}
  {#if error}<div class="alert alert-error w-full text-sm">{error}</div>{/if}
  <button type="button" class="btn btn-outline w-full" onclick={start}>Sign in with a code from another device</button>
{/if}
