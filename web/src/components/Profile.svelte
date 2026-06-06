<script lang="ts">
  // Reactive Svelte port of the imperative createProfile(user, posts, cb).
  // Same DOM structure / classes / element types; user + posts arrive as
  // reactive props (App.svelte builds them from the identity/posts stores).
  import type { Post, User } from "../types";
  import PostCard from "./PostCard.svelte";

  let {
    user,
    posts,
    onLike,
    onRepost,
    onQuote,
    onOpen,
    onSettings,
    bio,
    following,
    followers,
  }: {
    user: User;
    posts: Post[];
    onLike?: (postId: string, liked: boolean) => void;
    onRepost?: (postId: string, reposted: boolean) => void;
    onQuote?: (post: Post) => void;
    onOpen?: (post: Post) => void;
    onSettings?: () => void;
    bio?: string;
    following?: number;
    followers?: number;
  } = $props();

  function getInitials(displayName: string): string {
    return displayName
      .split(" ")
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }

  function truncateKey(key: string): string {
    if (key.length <= 22) return key;
    return `${key.slice(0, 10)}…${key.slice(-8)}`;
  }

  const resolveQuoted = (id: string): Post | undefined =>
    posts.find((p) => p.id === id);

  let stats = $derived<[number, string][]>([
    [posts.length, "Posts"],
    [following ?? 0, "Following"],
    [followers ?? 0, "Followers"],
  ]);
</script>

<main class="feed-column screen">
  <!-- Masthead -->
  <div class="masthead">
    <div class="masthead__row">
      <div>
        <div class="kicker">
          Identity · {posts.length} {posts.length === 1 ? "post" : "posts"}
        </div>
        <div class="masthead__title">{user.displayName}</div>
      </div>
    </div>
  </div>

  <!-- Header -->
  <div class="profile-header">
    <div class="profile-header__top">
      <div
        class="profile-header__avatar"
        style={user.avatarColor
          ? `background:${user.avatarColor};color:#fff;border-color:transparent;`
          : undefined}
      >
        {getInitials(user.displayName)}
      </div>
      <button class="profile-edit" onclick={() => onSettings?.()}>
        Edit profile
      </button>
    </div>
    <div class="profile-header__name">{user.displayName}</div>
    <div class="profile-header__handle">@{user.handle}</div>

    {#if bio}
      <p class="profile-header__bio">{bio}</p>
    {/if}

    <div class="profile-stats">
      {#each stats as [n, label]}
        <div class="profile-stat">
          <span class="profile-stat__num">{n}</span>
          <span class="profile-stat__label">{label}</span>
        </div>
      {/each}
    </div>

    {#if user.publicKey}
      <div class="profile-keyrow">
        <span class="profile-keyrow__label">ML-DSA-65</span>
        <span class="profile-keyrow__key">{truncateKey(user.publicKey)}</span>
        <span class="info-strip__badge" style="margin-left:auto;">
          ✓ verified
        </span>
      </div>
    {/if}
  </div>

  <!-- Posts list -->
  <div class="thread-rhead" style="padding-top:20px;"><span>Your posts</span></div>

  {#if posts.length === 0}
    <div class="screen-empty">Nothing posted yet.</div>
  {:else}
    {#each posts as post (post.id)}
      <PostCard
        {post}
        {onLike}
        {onRepost}
        {onQuote}
        {onOpen}
        {resolveQuoted}
      />
    {/each}
  {/if}
</main>
