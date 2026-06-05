import { createSidebar, SidebarView, SidebarHandle } from "./components/sidebar";
import { createFeed } from "./components/feed";
import { createProfile } from "./components/profile";
import { createRightPanel } from "./components/right-panel";
import { createNotifications } from "./components/notifications";
import { createExplore } from "./components/explore";
import { createSettings } from "./components/settings";
import { createThread } from "./components/thread";
import { openComposeModal } from "./components/compose-modal";
import { getIdentity } from "./identity";
import { Post } from "./types";

export interface AppCallbacks {
  publish: (content: string, shareToGlobal: boolean) => void;
  like: (postId: string, liked: boolean) => void;
  repost: (postId: string, reposted: boolean) => void;
  quote: (postId: string, content: string) => void;
  /** Reply to a thread root. */
  reply?: (rootPostId: string, content: string) => void;
}

type FeedEl = HTMLElement & {
  updatePosts: (p: Post[]) => void;
  updateDiscoverPosts: (p: Post[]) => void;
};

export function createApp(cb: AppCallbacks): HTMLElement {
  const posts: Post[] = [];
  const followedPubkeys = new Set<string>();

  const app = document.createElement("div");
  app.className = "app-layout";

  const mainArea = document.createElement("div");
  mainArea.className = "app-layout__main";

  let currentView: SidebarView = "feed";

  function openCompose(quoted?: Post): void {
    if (quoted) {
      // Quote modal does not offer the share toggle; ignore the (always-false)
      // shareToGlobal arg.
      openComposeModal((content) => cb.quote(quoted.id, content), { quoted });
    } else {
      openComposeModal((content, shareToGlobal) => cb.publish(content, shareToGlobal));
    }
  }

  // Build feed once, reuse across navigations.
  const feed = createFeed(posts, followedPubkeys, {
    onCompose: () => openCompose(),
    onOpen: (post) => openThread(post),
    onLike: cb.like,
    onRepost: cb.repost,
    onQuote: (post) => openCompose(post),
  }) as FeedEl;

  mainArea.appendChild(feed);

  let sidebar: SidebarHandle;

  function showFeed(): void {
    currentView = "feed";
    sidebar.setActiveView("feed");
    mainArea.replaceChildren(feed);
  }

  function showThread(root: Post, replies: Post[]): void {
    // Thread is a transient snapshot. Live like/repost/quote updates that
    // land while the user is viewing a thread won't visually reconcile here —
    // the next navigation rebuilds the feed from the latest `posts` array,
    // so authoritative state is preserved end-to-end. Sidebar shows "feed"
    // highlighted (current active screen *area*) since there's no thread
    // destination in nav.
    sidebar.setActiveView("feed");
    const screen = createThread(root, replies, {
      onBack: showFeed,
      onReply: (rootId, content) => cb.reply?.(rootId, content),
    });
    mainArea.replaceChildren(screen);
  }

  function openThread(post: Post): void {
    // For now, "replies" is the set of posts in `posts` that quote or reply
    // to this one. Reply-relationship wiring lands with #12 backend; until
    // then this surfaces quote-reposts of the root.
    const replies = posts.filter((p) => p.quotedPostId === post.id);
    showThread(post, replies);
  }

  function navigate(view: SidebarView): void {
    if (view === currentView) return;
    currentView = view;
    sidebar.setActiveView(view);

    if (view === "feed") {
      mainArea.replaceChildren(feed);
      return;
    }
    if (view === "explore") {
      mainArea.replaceChildren(createExplore());
      return;
    }
    if (view === "notifications") {
      mainArea.replaceChildren(createNotifications());
      return;
    }
    if (view === "profile") {
      const identity = getIdentity();
      if (!identity) {
        mainArea.replaceChildren(feed);
        currentView = "feed";
        sidebar.setActiveView("feed");
        return;
      }
      const myPosts = posts.filter(
        (p) => p.author.publicKey && p.author.publicKey === identity.publicKey,
      );
      const profileUser = {
        displayName: identity.displayName,
        handle: identity.handle,
        publicKey: identity.publicKey,
      };
      mainArea.replaceChildren(
        createProfile(profileUser, myPosts, {
          onLike: cb.like,
          onRepost: cb.repost,
          onQuote: (p) => openCompose(p),
          onOpen: (p) => openThread(p),
          onSettings: () => navigate("settings"),
        }),
      );
      return;
    }
    if (view === "settings") {
      mainArea.replaceChildren(createSettings());
      return;
    }
  }

  sidebar = createSidebar({
    onNavigate: navigate,
    onCompose: () => openCompose(),
    notifCount: 0,
  });
  app.appendChild(sidebar);
  app.appendChild(mainArea);

  // Right panel
  const rightCol = document.createElement("div");
  rightCol.className = "right-panel-col";
  rightCol.appendChild(createRightPanel({ onNavigate: navigate }));
  app.appendChild(rightCol);

  // Public surface used by index.ts to push updates.
  const appEl = app as unknown as HTMLElement & {
    updatePosts: (updatedPosts: Post[]) => void;
    updateGlobalPosts: (updatedPosts: Post[]) => void;
    addPost: (post: Post) => void;
  };

  appEl.updatePosts = (updatedPosts: Post[]) => {
    posts.length = 0;
    posts.push(...updatedPosts);
    feed.updatePosts(updatedPosts);
  };

  appEl.updateGlobalPosts = (updatedPosts: Post[]) => {
    feed.updateDiscoverPosts(updatedPosts);
  };

  appEl.addPost = (post: Post) => {
    posts.unshift(post);
    feed.updatePosts([...posts]);
  };

  return app;
}
