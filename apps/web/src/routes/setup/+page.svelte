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

<h1>Welcome to TessaTV</h1>
<p>Create the administrator account to finish setting up this server.</p>
<CredentialsForm submitLabel="Create account" confirmPassword onsubmit={createAdmin} />
