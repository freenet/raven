import { Post } from "../types";
import { createPostCard } from "./post-card";
import { getIdentity } from "../identity";

function getInitials(displayName: string): string {
  return displayName
    .split(" ")
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

export interface FeedCallbacks {
  onCompose: () => void;
  onOpen?: (post: Post) => void;
  onLike?: (postId: string, liked: boolean) => void;
  onRepost?: (postId: string, reposted: boolean) => void;
  onQuote?: (post: Post) => void;
}

type Tab = "following" | "discover";

export function createFeed(
  initialPosts: Post[],
  followedPubkeys: Set<string>,
  callbacks: FeedCallbacks,
): HTMLElement {
  const feed = document.createElement("main");
  feed.className = "feed-column screen";

  // ── Masthead ──
  const masthead = document.createElement("div");
  masthead.className = "masthead";

  const row = document.createElement("div");
  row.className = "masthead__row";

  const titleWrap = document.createElement("div");
  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = "The Feed";
  const title = document.createElement("div");
  title.className = "masthead__title";
  title.textContent = "Today on Freenet";
  titleWrap.appendChild(kicker);
  titleWrap.appendChild(title);

  row.appendChild(titleWrap);
  masthead.appendChild(row);

  // ── Tabs (Following | Discover) ──
  const tabs = document.createElement("div");
  tabs.className = "feed-tabs";

  let activeTab: Tab = "following";

  const tabFollowing = document.createElement("button");
  tabFollowing.className = "feed-tab feed-tab--on";
  tabFollowing.textContent = "Following";

  const tabDiscover = document.createElement("button");
  tabDiscover.className = "feed-tab";
  tabDiscover.textContent = "Discover";

  tabs.appendChild(tabFollowing);
  tabs.appendChild(tabDiscover);
  masthead.appendChild(tabs);

  // ── Quickpost row (opens compose modal) ──
  const quickpost = document.createElement("div");
  quickpost.className = "quickpost";

  const identity = getIdentity();
  const qAvatar = document.createElement("div");
  qAvatar.className = "post__avatar";
  qAvatar.textContent = identity ? getInitials(identity.displayName) : "·";

  const qField = document.createElement("div");
  qField.className = "quickpost__field";
  qField.textContent = "Share something with the network…";

  const qBtn = document.createElement("button");
  qBtn.className = "quickpost__btn";
  qBtn.textContent = "Compose";

  quickpost.appendChild(qAvatar);
  quickpost.appendChild(qField);
  quickpost.appendChild(qBtn);

  quickpost.addEventListener("click", () => callbacks.onCompose());
  qBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    callbacks.onCompose();
  });

  // ── Post list ──
  const postList = document.createElement("div");
  postList.className = "feed__posts";

  let currentPosts: Post[] = [...initialPosts];
  // Public-timeline (global-index) posts, shown under the Discover tab.
  let discoverPosts: Post[] = [];

  function renderPosts(): void {
    postList.innerHTML = "";
    if (activeTab === "discover") {
      if (discoverPosts.length === 0) {
        const note = document.createElement("div");
        note.className = "following-note";
        note.innerHTML = `
          <div class="following-note__title">No public posts yet</div>
          <div class="following-note__sub">Public posts from across the network will appear here.</div>
        `;
        postList.appendChild(note);
        return;
      }

      // Best-effort quoted-card resolution: only over discoverPosts. A quote
      // whose target is not in the public timeline (e.g. a reply — those are
      // filtered out upstream, or a post not present in the global index)
      // renders without its quoted card. Richer resolution would need a
      // per-target thread-shard fetch; out of scope for the read/render slice.
      const resolveQuoted = (id: string): Post | undefined =>
        discoverPosts.find((p) => p.id === id);

      discoverPosts.forEach((post, i) => {
        postList.appendChild(
          createPostCard(post, {
            onLike: callbacks.onLike,
            onRepost: callbacks.onRepost,
            onQuote: callbacks.onQuote,
            onOpen: callbacks.onOpen,
            resolveQuoted,
            lead: i === 0,
          }),
        );
      });
      return;
    }

    if (currentPosts.length === 0) {
      const note = document.createElement("div");
      note.className = "following-note";
      note.innerHTML = `
        <div class="following-note__title">Nothing here yet</div>
        <div class="following-note__sub">Follow people, or compose the first post.</div>
      `;
      postList.appendChild(note);
      return;
    }

    const resolveQuoted = (id: string): Post | undefined =>
      currentPosts.find((p) => p.id === id);

    currentPosts.forEach((post, i) => {
      postList.appendChild(
        createPostCard(post, {
          onLike: callbacks.onLike,
          onRepost: callbacks.onRepost,
          onQuote: callbacks.onQuote,
          onOpen: callbacks.onOpen,
          resolveQuoted,
          lead: i === 0,
        }),
      );
    });
  }

  function setActiveTab(next: Tab): void {
    if (next === activeTab) return;
    activeTab = next;
    tabFollowing.classList.toggle("feed-tab--on", next === "following");
    tabDiscover.classList.toggle("feed-tab--on", next === "discover");
    renderPosts();
  }
  tabFollowing.addEventListener("click", () => setActiveTab("following"));
  tabDiscover.addEventListener("click", () => setActiveTab("discover"));

  // Followed pubkeys are reserved for the future per-user-feed filter; not used yet.
  void followedPubkeys;

  renderPosts();

  feed.appendChild(masthead);
  feed.appendChild(quickpost);
  feed.appendChild(postList);

  const feedEl = feed as HTMLElement & {
    postList: HTMLDivElement;
    updatePosts: (posts: Post[]) => void;
    updateDiscoverPosts: (posts: Post[]) => void;
  };
  feedEl.postList = postList;
  feedEl.updatePosts = (updatedPosts: Post[]) => {
    currentPosts = updatedPosts;
    renderPosts();
  };
  feedEl.updateDiscoverPosts = (updatedPosts: Post[]) => {
    discoverPosts = updatedPosts;
    if (activeTab === "discover") renderPosts();
  };

  return feed;
}
