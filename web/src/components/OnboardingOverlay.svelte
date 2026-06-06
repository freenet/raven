<script lang="ts">
  import { APP_NAME, APP_LOGO_URL } from "../branding";

  let { onComplete }: {
    onComplete: (displayName: string, secretKey?: string) => void;
  } = $props();

  let name = $state("");
  let importName = $state("");
  let importSecret = $state("");
  let showImport = $state(false);

  let nameInput: HTMLInputElement | undefined = $state();

  const joinDisabled = $derived(name.trim().length === 0);
  const importDisabled = $derived(
    importName.trim().length === 0 || importSecret.trim().length !== 64
  );

  function submitJoin() {
    const n = name.trim();
    if (!n) return;
    onComplete(n);
  }

  function submitImport() {
    const n = importName.trim();
    const secret = importSecret.trim();
    if (!n || secret.length !== 64) return;
    onComplete(n, secret);
  }

  function onNameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") submitJoin();
  }

  $effect(() => {
    nameInput?.focus();
  });
</script>

<div class="onboarding-overlay">
  <div class="onboarding-card">
    <img
      class="onboarding-logo"
      src={APP_LOGO_URL}
      alt={`${APP_NAME} logo`}
      draggable="false"
    />
    <div class="onboarding-tagline">Decentralized Microblog</div>
    <h1 class="onboarding-title">Welcome to {APP_NAME}</h1>
    <p class="onboarding-subtitle">Choose your display name to get started</p>

    <div class="onboarding-section" style:display={showImport ? "none" : "flex"}>
      <input
        bind:this={nameInput}
        class="onboarding-input"
        type="text"
        placeholder="Your name"
        maxlength="50"
        autocomplete="off"
        spellcheck="false"
        bind:value={name}
        onkeydown={onNameKeydown}
      />
      <button class="onboarding-btn" disabled={joinDisabled} onclick={submitJoin}>
        Join
      </button>
    </div>

    <button class="onboarding-import-link" onclick={() => (showImport = !showImport)}>
      Import existing identity
    </button>

    <div class="onboarding-section" style:display={showImport ? "flex" : "none"}>
      <input
        class="onboarding-input"
        type="text"
        placeholder="Your name"
        maxlength="50"
        bind:value={importName}
      />
      <input
        class="onboarding-input onboarding-input--mono"
        type="password"
        placeholder="Secret key (64 hex characters)"
        maxlength="64"
        bind:value={importSecret}
      />
      <button class="onboarding-btn" disabled={importDisabled} onclick={submitImport}>
        Import
      </button>
    </div>
  </div>
</div>
