<script lang="ts">
  import type { ExploreItem } from "./view-types";

  const ICON_SEARCH = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="11" cy="11" r="7"/>
  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
</svg>`;

  let { items = [] }: { items?: ExploreItem[] } = $props();

  let query = $state("");

  const q = $derived(query.trim().toLowerCase());
  const filtered = $derived(
    q
      ? items.filter(
          (e) =>
            e.topic.toLowerCase().includes(q) ||
            e.category.toLowerCase().includes(q),
        )
      : items,
  );
</script>

<main class="feed-column screen">
  <div class="masthead">
    <div class="masthead__row">
      <div>
        <div class="kicker">The Network · Discover</div>
        <div class="masthead__title">Explore</div>
      </div>
    </div>
    <div class="feed-tabs">
      <button class="feed-tab feed-tab--on">Trending</button>
    </div>
  </div>

  <div class="explore-search">
    <span class="explore-search__icon">{@html ICON_SEARCH}</span>
    <input
      class="explore-search__input"
      placeholder="Search topics, people, keys"
      bind:value={query}
    />
  </div>

  <div class="explore-list">
    {#if filtered.length === 0}
      {#if q}
        <div class="screen-empty">No topics match "{query}".</div>
      {:else}
        <div class="following-note">
          <div class="following-note__title">No trending topics yet</div>
          <div class="following-note__sub">
            Topics will surface here once discovery indexing comes online.
          </div>
        </div>
      {/if}
    {:else}
      {#each filtered as item, i}
        <div class="explore-item">
          <div class="explore-item__rank">{i + 1}</div>
          <div class="explore-item__body">
            <span class="explore-item__cat">{item.category}</span>
            <span class="explore-item__topic">{item.topic}</span>
            <span class="explore-item__count">{item.count}</span>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</main>
