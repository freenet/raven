<script lang="ts">
  import type { NotificationRecord } from "./view-types";

  let { records = [] }: { records?: NotificationRecord[] } = $props();

  const ICON: Record<NotificationRecord["kind"], string> = {
    like: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z"/></svg>`,
    repost: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l4-4 4 4"/><path d="M7 4v11a2 2 0 0 0 2 2h7"/><path d="M21 16l-4 4-4-4"/><path d="M17 20V9a2 2 0 0 0-2-2H8"/></svg>`,
    reply: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18v11a2 2 0 0 1-2 2H8l-5 3V6z"/></svg>`,
    mention: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>`,
    follow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>`,
  };

  const VERB: Record<NotificationRecord["kind"], string> = {
    like: "liked your post",
    repost: "reposted your post",
    reply: "replied to you",
    mention: "mentioned you",
    follow: "followed you",
  };

  function getInitials(displayName: string): string {
    return displayName
      .split(" ")
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }
</script>

<main class="feed-column screen">
  <div class="masthead">
    <div class="masthead__row">
      <div>
        <div class="kicker">Signed activity</div>
        <div class="masthead__title">Notifications</div>
      </div>
    </div>
    <div class="feed-tabs">
      <button class="feed-tab feed-tab--on">All</button>
      <button class="feed-tab">Mentions</button>
    </div>
  </div>

  {#if records.length === 0}
    <div class="following-note">
      <div class="following-note__title">Quiet on the network</div>
      <div class="following-note__sub">Likes, reposts, replies and follows will appear here as they sign in.</div>
    </div>
  {:else}
    {#each records as r (r.id)}
      <div class="notif">
        <div class="notif__icon notif__icon--{r.kind}">{@html ICON[r.kind]}</div>
        <div class="notif__body">
          <div class="notif__avatars">
            {#each r.actors as a}
              <div
                class="post__avatar"
                style:width="30px"
                style:height="30px"
                style:font-size="12px"
                style:background={a.avatarColor ? a.avatarColor : undefined}
                style:color={a.avatarColor ? "#fff" : undefined}
                style:border-color={a.avatarColor ? "transparent" : undefined}
              >{getInitials(a.displayName)}</div>
            {/each}
          </div>
          <div class="notif__text">
            {#if r.actors.length === 1}<b>{r.actors[0].displayName}</b>{:else if r.actors.length === 2}<b
                >{r.actors[0].displayName}</b
              > and <b>{r.actors[1].displayName}</b>{:else}<b>{r.actors[0].displayName}</b>, <b
                >{r.actors[1].displayName}</b
              > and {r.actors.length - 2} others{/if}
            {` ${VERB[r.kind]}`}<span class="notif__when">{r.ts}</span>
          </div>
          {#if r.text}
            <div class="notif__reply">{r.text}</div>
          {/if}
          {#if r.post}
            <div class="notif__excerpt">{r.post}</div>
          {/if}
        </div>
      </div>
    {/each}
  {/if}
</main>
