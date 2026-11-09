<script lang="ts">
  let {
    submitLabel,
    confirmPassword = false,
    onsubmit,
  }: {
    submitLabel: string;
    /** Adds a "confirm password" field (for account creation). */
    confirmPassword?: boolean;
    onsubmit: (username: string, password: string) => Promise<string | null>;
  } = $props();

  let username = $state("");
  let password = $state("");
  let confirmation = $state("");
  let error = $state<string | null>(null);
  let submitting = $state(false);

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (confirmPassword && password !== confirmation) {
      error = "Passwords don't match";
      return;
    }
    submitting = true;
    error = await onsubmit(username, password);
    submitting = false;
  }
</script>

<form onsubmit={handleSubmit} class="fieldset w-full max-w-xs gap-3">
  <label class="floating-label">
    <span>Username</span>
    <input class="input w-full" placeholder="Username" bind:value={username} autocomplete="username" autocapitalize="none" required />
  </label>
  <label class="floating-label">
    <span>Password</span>
    <input
      class="input w-full"
      type="password"
      placeholder="Password"
      bind:value={password}
      autocomplete={confirmPassword ? "new-password" : "current-password"}
      required
    />
  </label>
  {#if confirmPassword}
    <label class="floating-label">
      <span>Confirm password</span>
      <input class="input w-full" type="password" placeholder="Confirm password" bind:value={confirmation} autocomplete="new-password" required />
    </label>
  {/if}
  {#if error}
    <div class="alert alert-error alert-soft" role="alert">{error}</div>
  {/if}
  <button type="submit" class="btn btn-primary" disabled={submitting}>
    {#if submitting}<span class="loading loading-spinner loading-sm"></span>{/if}
    {submitLabel}
  </button>
</form>
