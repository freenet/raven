import "./scss/styles.scss";
import { createApp } from "./app";
import { FreenetConnection } from "./freenet-api";
import { Post } from "./types";
import { createPostCard } from "./components/post-card";
import { createOnboarding } from "./components/onboarding";
import {
  hasIdentity,
  getIdentity,
  createIdentity,
  applyDelegateIdentity,
  connectDelegate,
  Identity,
} from "./identity";
import { parseDelegateResponse } from "./delegate-api";
import { DelegateResponse } from "@freenetorg/freenet-stdlib";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("No #app element");

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
    if (knownPostIds.has(post.id)) return;
    knownPostIds.add(post.id);
    const postList = appElement.querySelector(".feed__posts") as HTMLElement | null;
    if (postList) {
      postList.insertBefore(createPostCard(post), postList.firstChild);
    }
  },
  onStatusChange: (status) => {
    console.log(`[freenet] Status: ${status}`);
    // Wire delegate after WebSocket connects
    if (status === "connected" && __DELEGATE_KEY__) {
      wireDelegateConnection();
    }
  },
  onDelegateResponse: (response: DelegateResponse) => {
    const payloads = parseDelegateResponse(response);
    for (const payload of payloads) {
      if (applyDelegateIdentity(payload)) {
        const identity = getIdentity();
        if (identity) {
          connection.setUser(identity.publicKey, identity.displayName, identity.handle);
          console.log(`[identity] Updated from delegate: ${identity.displayName}`);
        }
      }
    }
  },
});

const appElement = createApp((content: string) => {
  connection.publishPost(content).then((ok) => {
    if (ok) {
      console.log("[freenet] Post published");
      setTimeout(() => connection.loadState(), 300);
    }
  });
  return Promise.resolve(true);
});
appRoot.appendChild(appElement);

/**
 * Wire the identity delegate after WebSocket is connected.
 * Decodes the delegate key (base58) and calls connectDelegate.
 */
async function wireDelegateConnection(): Promise<void> {
  const api = connection.wsApi;
  if (!api || !__DELEGATE_KEY__) return;

  try {
    // Decode delegate key (base58) using ContractKey.fromInstanceId
    // to get the raw 32 bytes. Pass as both key and codeHash.
    const { ContractKey } = await import("@freenetorg/freenet-stdlib");
    const tempKey = ContractKey.fromInstanceId(__DELEGATE_KEY__);
    const keyBytes = Array.from(tempKey.bytes());

    connectDelegate(api, keyBytes, keyBytes);
    console.log(`[identity] Delegate wired: ${__DELEGATE_KEY__}`);
  } catch (e) {
    console.warn("[identity] Failed to wire delegate:", e);
  }
}

function startWithIdentity(identity: Identity): void {
  connection.setUser(identity.publicKey, identity.displayName, identity.handle);
  connection.connect();
}

if (hasIdentity()) {
  startWithIdentity(getIdentity()!);
} else {
  const onboarding = createOnboarding((displayName: string) => {
    const identity = createIdentity(displayName);
    startWithIdentity(identity);
  });
  document.body.appendChild(onboarding);
}
