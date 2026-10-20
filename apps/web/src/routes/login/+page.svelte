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

<h1>Sign in</h1>
<CredentialsForm submitLabel="Sign in" onsubmit={login} />
