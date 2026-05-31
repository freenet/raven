import { Post } from "../types";
import { formatRelativeTime } from "../utils";
import { getIdentity } from "../identity";

const ICON_BACK = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <line x1="20" y1="12" x2="4" y2="12"/>
  <polyline points="10 18 4 12 10 6"/>
</svg>`;

const ICON_SHIELD = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z"/>
</svg>`;

function getInitials(displayName: string): string {
  return displayName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function avatarEl(post: Post, size = 38, fontSize = 14): HTMLElement {
  const av = document.createElement("div");
  av.className = "post__avatar";
  av.style.width = `${size}px`;
  av.style.height = `${size}px`;
  av.style.fontSize = `${fontSize}px`;
  av.textContent = getInitials(post.author.displayName);
  if (post.author.avatarColor) {
    av.style.background = post.author.avatarColor;
    av.style.color = "#fff";
    av.style.borderColor = "transparent";
  }
  return av;
}

export interface ThreadCallbacks {
  onBack: () => void;
  onReply: (rootPostId: string, content: string) => void;
}

/**
 * Render the conversation around `root`. `replies` is the resolved thread-shard
 * reply set in display order. Nested replies are not currently distinguished —
 * the design supports it but we don't track parent_reply_id yet.
 */
export function createThread(
  root: Post,
  replies: Post[],
  callbacks: ThreadCallbacks,
): HTMLElement {
  const screen = document.createElement("main");
  screen.className = "feed-column screen";

  // Detail head (back + title)
  const head = document.createElement("div");
  head.className = "thread-head";

  const back = document.createElement("button");
  back.className = "thread-back";
  back.innerHTML = ICON_BACK;
  back.setAttribute("aria-label", "Back");
  back.addEventListener("click", callbacks.onBack);

  const headTitle = document.createElement("span");
  headTitle.className = "thread-head__title";
  headTitle.textContent = "The Feed · Conversation";

  head.appendChild(back);
  head.appendChild(headTitle);

  // Root post block
  const rootBlock = document.createElement("div");
  rootBlock.className = "thread-root";

  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = "Dispatch · No. 0.1.0";

  const rootText = document.createElement("p");
  rootText.className = "thread-root__text";
  rootText.textContent = root.content;

  const rootByline = document.createElement("div");
  rootByline.className = "thread-root__byline";
  rootByline.appendChild(avatarEl(root, 38, 14));
  const rWho = document.createElement("div");
  rWho.className = "post__who";
  const rName = document.createElement("span");
  rName.className = "post__name";
  rName.textContent = root.author.displayName;
  const rWhen = document.createElement("span");
  rWhen.className = "post__when";
  rWhen.innerHTML = `@${root.author.handle}<i>·</i>${formatRelativeTime(root.timestamp)}`;
  rWho.appendChild(rName);
  rWho.appendChild(rWhen);
  rootByline.appendChild(rWho);

  const seal = document.createElement("div");
  seal.className = "thread-seal";
  const keyTrunc = root.author.publicKey
    ? `${root.author.publicKey.slice(0, 6)}…${root.author.publicKey.slice(-4)}`
    : "—";
  seal.innerHTML = `${ICON_SHIELD}<span>Signed · root key ${keyTrunc} · <b>ML-DSA-65</b></span>`;

  rootBlock.appendChild(kicker);
  rootBlock.appendChild(rootText);
  rootBlock.appendChild(rootByline);
  rootBlock.appendChild(seal);

  // Reply composer
  const compose = document.createElement("div");
  compose.className = "thread-compose";

  const identity = getIdentity();
  const cAvatar = document.createElement("div");
  cAvatar.className = "post__avatar";
  cAvatar.style.width = "32px";
  cAvatar.style.height = "32px";
  cAvatar.style.fontSize = "13px";
  cAvatar.textContent = identity ? getInitials(identity.displayName) : "·";

  const cField = document.createElement("textarea");
  cField.className = "thread-compose__field";
  cField.placeholder = "Add your reply…";
  cField.rows = 1;

  const cBtn = document.createElement("button");
  cBtn.className = "thread-compose__btn";
  cBtn.textContent = "Reply";
  cBtn.disabled = true;

  cField.addEventListener("input", () => {
    cBtn.disabled = cField.value.trim().length === 0;
  });
  cBtn.addEventListener("click", () => {
    const content = cField.value.trim();
    if (!content) return;
    callbacks.onReply(root.id, content);
    cField.value = "";
    cBtn.disabled = true;
  });
  cField.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && cField.value.trim()) {
      e.preventDefault();
      cBtn.click();
    }
  });

  compose.appendChild(cAvatar);
  compose.appendChild(cField);
  compose.appendChild(cBtn);

  // Responses header
  const rhead = document.createElement("div");
  rhead.className = "thread-rhead";
  rhead.innerHTML = `<span>Responses · ${replies.length}</span>`;

  screen.appendChild(head);
  screen.appendChild(rootBlock);
  screen.appendChild(compose);
  screen.appendChild(rhead);

  // Reply rows
  for (const reply of replies) {
    screen.appendChild(renderReply(reply));
  }

  if (replies.length === 0) {
    const empty = document.createElement("div");
    empty.className = "screen-empty";
    empty.textContent = "No replies yet — be the first.";
    screen.appendChild(empty);
  }

  return screen;
}

function renderReply(reply: Post): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "thread-reply";

  const byline = document.createElement("div");
  byline.className = "thread-reply__byline";
  byline.appendChild(avatarEl(reply, 32, 13));
  const who = document.createElement("div");
  who.className = "post__who";
  const name = document.createElement("span");
  name.className = "thread-reply__name";
  name.textContent = reply.author.displayName;
  const meta = document.createElement("span");
  meta.className = "thread-reply__meta";
  meta.textContent = `@${reply.author.handle} · ${formatRelativeTime(reply.timestamp)}`;
  who.appendChild(name);
  who.appendChild(meta);
  byline.appendChild(who);

  const text = document.createElement("p");
  text.className = "thread-reply__text";
  text.textContent = reply.content;

  wrap.appendChild(byline);
  wrap.appendChild(text);
  return wrap;
}
