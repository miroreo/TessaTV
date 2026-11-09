<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import CredentialsForm from "$lib/CredentialsForm.svelte";
  import { submitCredentials } from "$lib/session.js";

  async function login(username: string, password: string) {
    const error = await submitCredentials("/api/auth/login", username, password);
    if (!error) {
      await invalidateAll();
      await goto("/");
    }
    return error;
  }
</script>

<div class="card bg-base-200 mx-auto mt-12 max-w-sm">
  <div class="card-body items-center">
    <h1 class="card-title text-2xl">Sign in</h1>
    <CredentialsForm submitLabel="Sign in" onsubmit={login} />
  </div>
</div>
