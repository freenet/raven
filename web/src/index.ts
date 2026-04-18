import "./scss/styles.scss";
import { createApp } from "./app";
import { FreenetConnection } from "./freenet-api";
import { Post } from "./types";
import { createPostCard } from "./components/post-card";
import { createOnboarding } from "./components/onboarding";
import { hasIdentity, getIdentity, createIdentity, Identity } from "./identity";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("No #app element");

// Track known post IDs to avoid duplicates
const knownPostIds = new Set<string>();

const connection = new FreenetConnection({
  onPostsLoaded: (posts: Post[]) => {
    console.log(`[freenet] Loaded ${posts.length} posts from network`);
    const postList = appElement.querySelector(".feed__posts") as HTMLElement | null;
    if (postList) {
      postList.innerHTML = "";
      knownPostIds.clear();
      for (const post of posts) {
        knownPostIds.add(post.id);
        postList.appendChild(createPostCard(post));
      }
    }
  },
  onNewPost: (post: Post) => {
    if (knownPostIds.has(post.id)) return; // dedup
    knownPostIds.add(post.id);
    console.log(`[freenet] New post from @${post.author.handle}`);
    const postList = appElement.querySelector(".feed__posts") as HTMLElement | null;
    if (postList) {
      postList.insertBefore(createPostCard(post), postList.firstChild);
    }
  },
  onStatusChange: (status) => {
    console.log(`[freenet] Status: ${status}`);
  },
});

const appElement = createApp((content: string) => {
  connection.publishPost(content).then((ok) => {
    if (ok) {
      console.log("[freenet] Post published to network");
      // Reload state after a short delay to show the new post
      setTimeout(() => connection.loadState(), 300);
    } else {
      console.warn("[freenet] Post publish failed");
    }
  });
  return Promise.resolve(true);
});
appRoot.appendChild(appElement);

/**
 * Wire up the identity to the connection and then connect.
 */
function startWithIdentity(identity: Identity): void {
  connection.setUser(identity.publicKey, identity.displayName, identity.handle);
  connection.connect();
}

// Identity flow:
//   1. Identity exists in memory → connect immediately
//   2. No identity → show onboarding → create identity → connect
if (hasIdentity()) {
  const identity = getIdentity()!;
  console.log(`[identity] Resuming as ${identity.displayName} (@${identity.handle})`);
  startWithIdentity(identity);
} else {
  const onboarding = createOnboarding((displayName: string) => {
    const identity = createIdentity(displayName);
    console.log(
      `[identity] Created identity: ${identity.displayName} (@${identity.handle}) pubkey=${identity.publicKey.slice(0, 16)}…`
    );
    startWithIdentity(identity);
  });
  document.body.appendChild(onboarding);
}
