<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import CredentialsForm from "$lib/CredentialsForm.svelte";
  import { submitCredentials } from "$lib/session.js";

  async function createAdmin(username: string, password: string) {
    const error = await submitCredentials("/api/auth/setup", username, password);
    if (!error) {
      await invalidateAll();
      await goto("/");
    }
    return error;
  }
</script>

<div class="card bg-base-200 mx-auto mt-12 max-w-sm">
  <div class="card-body items-center text-center">
    <h1 class="card-title text-2xl">Welcome to TessaTV</h1>
    <p class="opacity-70">Create the administrator account to finish setting up this server.</p>
    <CredentialsForm submitLabel="Create account" confirmPassword onsubmit={createAdmin} />
  </div>
</div>
