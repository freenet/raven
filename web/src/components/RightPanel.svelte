<script lang="ts">
  import type { SidebarView } from "./sidebar";

  let { onNavigate }: { onNavigate?: (view: SidebarView) => void } = $props();
</script>

<div class="right-panel">
  <!-- Search → opens explore -->
  <div
    class="search-box"
    style="cursor: pointer;"
    onclick={() => onNavigate?.("explore")}
    role="button"
    tabindex="0"
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") onNavigate?.("explore");
    }}
  >
    <input
      type="search"
      class="search-box__input"
      placeholder="Search Raven"
      aria-label="Search"
      readonly
    />
    <span class="search-box__icon">⌕</span>
  </div>

  <!-- Network strip -->
  <div class="info-strip">
    <span class="info-strip__label">Network</span>
    <span class="info-strip__content">P2P · encrypted</span>
    <span class="info-strip__badge">✓ live</span>
  </div>

  <!-- Trending (empty scaffold) -->
  <div class="panel-card">
    <div class="panel-card__header">
      <div class="panel-card__title">Trending on Freenet</div>
      <div class="panel-card__subtitle">Discovery in progress</div>
    </div>
    <div class="panel-card__body">
      Topics will surface here once discovery indexing comes online.
    </div>
    <a
      class="panel-card__more"
      style="cursor: pointer;"
      onclick={() => onNavigate?.("explore")}
      role="button"
      tabindex="0"
      onkeydown={(e) => {
        if (e.key === "Enter" || e.key === " ") onNavigate?.("explore");
      }}
    >Open explore</a>
  </div>

  <!-- Who to follow (empty scaffold) -->
  <div class="panel-card">
    <div class="panel-card__header">
      <div class="panel-card__title">Who to follow</div>
      <div class="panel-card__subtitle">On the network</div>
    </div>
    <div class="panel-card__body">
      Suggestions appear once you start following or post content others react to.
    </div>
  </div>

  <!-- About -->
  <div class="panel-card">
    <div class="panel-card__header">
      <div class="panel-card__title">About Freenet</div>
      <div class="panel-card__subtitle">Decentralized · P2P</div>
    </div>
    <div class="about-card__body">
      <p class="about-card__desc">
        A decentralized social network. Your data, your keys, your control. No
        servers, no trackers.
      </p>
      <a
        class="about-card__link"
        href="https://freenet.org"
        target="_blank"
        rel="noopener noreferrer"
      >freenet.org →</a>
    </div>
  </div>
</div>
