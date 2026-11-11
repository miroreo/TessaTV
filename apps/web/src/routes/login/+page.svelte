<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import CredentialsForm from "$lib/CredentialsForm.svelte";
  import PairingCode from "$lib/PairingCode.svelte";
  import { submitCredentials } from "$lib/session.js";
  import type { PageData } from "./$types.js";

  let { data }: { data: PageData } = $props();

  /** Set by the SSO callback when a sign-in didn't work out. */
  const ssoError = $derived(page.url.searchParams.get("error"));

  /** Where to go after signing in; same-site paths only. */
  const next = $derived.by(() => {
    const value = page.url.searchParams.get("next");
    return value && /^\/(?![/\\])/.test(value) ? value : null;
  });
  const ssoHref = $derived(next ? `/api/auth/oidc/login?next=${encodeURIComponent(next)}` : "/api/auth/oidc/login");

  async function signedInElsewhere() {
    await invalidateAll();
    await goto(next ?? "/");
  }

  async function login(username: string, password: string) {
    const error = await submitCredentials("/api/auth/login", username, password);
    if (!error) {
      await invalidateAll();
      await goto(next ?? "/");
    }
    return error;
  }
</script>

<div class="card bg-base-200 mx-auto mt-12 max-w-sm">
  <div class="card-body items-center">
    <h1 class="card-title text-2xl">Sign in</h1>
    {#if ssoError}<div class="alert alert-error w-full text-sm">{ssoError}</div>{/if}
    {#if data.session.sso}
      <!-- A full page load: the server redirects to the sign-in provider. -->
      <a class="btn btn-warning w-full" href={ssoHref} data-sveltekit-reload>{data.session.sso.buttonLabel}</a>
      <details class="collapse-arrow collapse w-full">
        <summary class="collapse-title text-sm opacity-70">Sign in with a password</summary>
        <div class="collapse-content">
          <CredentialsForm submitLabel="Sign in" onsubmit={login} />
        </div>
      </details>
    {:else}
      <CredentialsForm submitLabel="Sign in" onsubmit={login} />
    {/if}
    <div class="divider my-0">or</div>
    <PairingCode onapproved={signedInElsewhere} />
  </div>
</div>
