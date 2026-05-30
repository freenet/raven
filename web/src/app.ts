import { createSidebar, SidebarView } from "./components/sidebar";
import { createFeed } from "./components/feed";
import { createProfile } from "./components/profile";
import { createRightPanel } from "./components/right-panel";
import { createQuoteComposer } from "./components/compose-box";
import { getIdentity } from "./identity";
import { Post } from "./types";

/** Open a modal quote composer for `quoted`; on submit, fire `quoteFn`. */
function openQuoteComposer(
  quoted: Post,
  quoteFn?: (postId: string, content: string) => void,
): void {
  if (!quoteFn) return;
  document.querySelector(".quote-modal-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "quote-modal-overlay";
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:1100",
    "background:rgba(0,0,0,0.4)",
    "display:flex",
    "align-items:flex-start",
    "justify-content:center",
    "padding-top:10vh",
  ].join(";");

  const panel = document.createElement("div");
  panel.style.cssText = [
    "width:min(560px,92vw)",
    "background:var(--surface-0)",
    "border:1px solid var(--line)",
    "border-radius:16px",
    "padding:14px 16px",
    "box-shadow:0 12px 40px rgba(0,0,0,0.25)",
  ].join(";");

  const close = (): void => overlay.remove();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener(
    "keydown",
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", onKey, true);
      }
    },
    true,
  );

  const composer = createQuoteComposer(quoted, (content: string) => {
    quoteFn(quoted.id, content);
    close();
  });
  panel.appendChild(composer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

export function createApp(
  publishFn?: (content: string) => Promise<boolean>,
  likeFn?: (postId: string, liked: boolean) => void,
  repostFn?: (postId: string, reposted: boolean) => void,
  quoteFn?: (postId: string, content: string) => void,
): HTMLElement {
  const posts: Post[] = [];
  const followedPubkeys = new Set<string>();

  const app = document.createElement("div");
  app.className = "app-layout";

  // Main content area (feed or profile)
  const mainArea = document.createElement("div");
  mainArea.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;";

  // Track current view
  let currentView: SidebarView = "feed";

  // Build feed element (created once, shown/hidden)
  const feed = createFeed(
    posts,
    (content: string) => {
      if (publishFn) {
        publishFn(content).catch((e) =>
          console.error("[freenet] Publish failed:", e)
        );
      }
    },
    followedPubkeys,
    likeFn,
    repostFn,
    (quoted: Post) => openQuoteComposer(quoted, quoteFn)
  );

  mainArea.appendChild(feed);

  // Navigation handler
  function navigate(view: SidebarView): void {
    if (view === currentView) return;
    currentView = view;

    // Remove current child and replace
    mainArea.innerHTML = "";

    if (view === "feed") {
      mainArea.appendChild(feed);
    } else if (view === "profile") {
      const identity = getIdentity();
      if (identity) {
        // Filter posts authored by the current user
        const myPosts = posts.filter(
          (p) => p.author.publicKey && p.author.publicKey === identity.publicKey
        );
        const profileUser = {
          displayName: identity.displayName,
          handle: identity.handle,
          publicKey: identity.publicKey,
        };
        const profileEl = createProfile(profileUser, myPosts);
        mainArea.appendChild(profileEl);
      } else {
        // No identity yet — fall back to feed
        currentView = "feed";
        mainArea.appendChild(feed);
      }
    }
  }

  const sidebar = createSidebar({ onNavigate: navigate });
  app.appendChild(sidebar);

  app.appendChild(mainArea);

  // Right panel column
  const rightCol = document.createElement("div");
  rightCol.className = "right-panel-col";
  rightCol.style.cssText = [
    "width:var(--right-panel-width, 320px)",
    "flex-shrink:0",
    "padding:0 18px",
    "min-height:100vh",
    "border-left:1px solid var(--line)",
    "background:transparent",
  ].join(";");

  const rightPanel = createRightPanel();
  rightCol.appendChild(rightPanel);
  app.appendChild(rightCol);

  // Expose feed methods for external updates
  const appEl = app as unknown as HTMLElement & {
    updatePosts: (updatedPosts: Post[]) => void;
    addPost: (post: Post) => void;
  };

  appEl.updatePosts = (updatedPosts: Post[]) => {
    posts.length = 0;
    posts.push(...updatedPosts);
    const feedEl = feed as HTMLElement & { updatePosts: (p: Post[]) => void };
    feedEl.updatePosts(updatedPosts);
  };

  appEl.addPost = (post: Post) => {
    posts.unshift(post);
    const feedEl = feed as HTMLElement & { updatePosts: (p: Post[]) => void };
    feedEl.updatePosts([...posts]);
  };

  return app;
}
