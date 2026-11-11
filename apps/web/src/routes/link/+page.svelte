<script lang="ts">
  import { page } from "$app/state";
  import { ApiError, api } from "$lib/api.js";

  // A TV's prompt can link here with the code filled in.
  let code = $state(page.url.searchParams.get("code")?.replace(/\D/g, "").slice(0, 6) ?? "");
  let busy = $state(false);
  let message = $state<{ kind: "success" | "error"; text: string } | null>(null);

  async function authorize(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    message = null;
    try {
      await api<void>(fetch, "/api/auth/quick-connect/authorize", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
      message = { kind: "success", text: "Done. The device is signing in as you." };
      code = "";
    } catch (error) {
      message = { kind: "error", text: error instanceof ApiError ? error.message : "Something went wrong. Try again." };
    } finally {
      busy = false;
    }
  }
</script>

<div class="card bg-base-200 mx-auto mt-12 max-w-sm">
  <div class="card-body items-center text-center">
    <h1 class="card-title text-2xl">Sign in a TV</h1>
    <p class="opacity-70">
      Open a Jellyfin app on your TV, choose Quick Connect, and type the six-digit code it shows. The device signs in as you.
    </p>
    <form class="flex w-full flex-col gap-3" onsubmit={authorize}>
      <input
        class="input input-lg w-full text-center font-mono tracking-widest"
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern="[0-9]{'{6}'}"
        maxlength="6"
        placeholder="000000"
        aria-label="Code shown on the device"
        bind:value={code}
        required
      />
      <button class="btn btn-primary" disabled={busy || code.trim().length !== 6}>Authorize</button>
    </form>
    {#if message}<div class="alert alert-{message.kind} w-full text-sm" role="status">{message.text}</div>{/if}
  </div>
</div>
