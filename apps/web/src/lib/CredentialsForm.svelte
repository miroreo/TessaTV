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

<form onsubmit={handleSubmit}>
  <label>
    Username
    <input bind:value={username} autocomplete="username" autocapitalize="none" required />
  </label>
  <label>
    Password
    <input
      type="password"
      bind:value={password}
      autocomplete={confirmPassword ? "new-password" : "current-password"}
      required
    />
  </label>
  {#if confirmPassword}
    <label>
      Confirm password
      <input type="password" bind:value={confirmation} autocomplete="new-password" required />
    </label>
  {/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  <button type="submit" disabled={submitting}>{submitLabel}</button>
</form>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: 20rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  input {
    font-size: 1rem;
    padding: 0.5rem;
  }
  button {
    font-size: 1rem;
    padding: 0.5rem;
  }
  .error {
    color: #f77;
    margin: 0;
  }
</style>
