<script lang="ts">
  /**
   * LandingFeed.svelte — read-only public-timeline list shown behind the
   * onboarding overlay (was index.ts createLandingFeed()). Logged-out visitors
   * have no delegate/identity, so cards get NO action callbacks — there is no
   * compose/like/repost/quote here (those require signing).
   *
   * Markup contract: `main.feed-column screen landing-feed` wrapping a
   * `.feed__posts` list, exactly as the imperative version emitted.
   */
  import type { Post } from "../types";
  import PostCard from "./PostCard.svelte";

  let { posts = [] }: { posts?: Post[] } = $props();

  // Read-only resolver so quote-embeds still render against the same buffer.
  const resolveQuoted = (id: string): Post | undefined =>
    posts.find((p) => p.id === id);
</script>

<main class="feed-column screen landing-feed">
  <div class="feed__posts">
    {#each posts as post (post.id)}
      <PostCard {post} {resolveQuoted} />
    {/each}
  </div>
</main>
