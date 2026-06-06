<script lang="ts">
  // Modal that displays the exported secret key with copy + warning.
  // Reactive port of the imperative showKeyExportModal(secret): the
  // keyExportSecret store drives visibility via the `secret` prop.
  let { secret, onClose }: { secret: string | null; onClose: () => void } =
    $props();

  let copyLabel = $state("Copy");
  let keyBox: HTMLDivElement;

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret ?? "");
      copyLabel = "Copied ✓";
      setTimeout(() => (copyLabel = "Copy"), 1600);
    } catch {
      // Fallback: select text in keyBox
      const range = document.createRange();
      range.selectNodeContents(keyBox);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  function onOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if secret != null}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="key-export-overlay" onclick={onOverlayClick}>
    <div class="key-export-card">
      <div class="key-export-card__title">Your secret key</div>
      <div class="key-export-card__subtitle">
        Save it &middot; Anyone with this key controls your identity
      </div>
      <div class="key-export-card__key" bind:this={keyBox}>{secret}</div>
      <div class="key-export-card__actions">
        <button class="btn btn--primary" onclick={copy}>{copyLabel}</button>
        <button class="btn btn--secondary" onclick={onClose}>Close</button>
      </div>
    </div>
  </div>
{/if}
