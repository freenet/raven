import { Post } from "../types";
import { formatRelativeTime } from "../utils";
import { getIdentity } from "../identity";

function getInitials(displayName: string): string {
  return displayName
    .split(" ")
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

const ICON_REPLY = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 4h14v8a2 2 0 0 1-2 2H6l-4 2V4z"/>
</svg>`;

const ICON_REPOST = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 7l4-4 4 4"/>
  <path d="M5 3v9a2 2 0 0 0 2 2h5"/>
  <path d="M17 11l-4 4-4-4"/>
  <path d="M13 15V6a2 2 0 0 0-2-2H6"/>
</svg>`;

const ICON_LIKE = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M9 15.5s-7-4.2-7-8.5a4 4 0 0 1 7-2.65A4 4 0 0 1 16 7c0 4.3-7 8.5-7 8.5z"/>
</svg>`;

const ICON_LIKE_FILLED = `<svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M9 15.5s-7-4.2-7-8.5a4 4 0 0 1 7-2.65A4 4 0 0 1 16 7c0 4.3-7 8.5-7 8.5z"/>
</svg>`;

const ICON_SHARE = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 12v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"/>
  <polyline points="12 6 9 3 6 6"/>
  <line x1="9" y1="3" x2="9" y2="12"/>
</svg>`;

export interface PostCardCallbacks {
  /** Fired on a like toggle. `liked` is the new desired state. */
  onLike?: (postId: string, liked: boolean) => void;
  /** Fired on a plain-repost toggle. `reposted` is the new desired state. */
  onRepost?: (postId: string, reposted: boolean) => void;
  /** Fired when the user picks "Quote" — opens a quote composer for this post. */
  onQuote?: (post: Post) => void;
  /** Resolve a quoted post's id to a Post for the embed, if present in the feed. */
  resolveQuoted?: (postId: string) => Post | undefined;
}

/**
 * Small popover anchored to the repost button offering Repost / Quote, the
 * X/Threads pattern. Closes on selection, outside click, or Escape. Kept
 * dependency-free (no menu lib) and inline-styled to match the action bar.
 */
function openRepostMenu(
  anchor: HTMLElement,
  opts: { reposted: boolean; onRepost: () => void; onQuote: () => void },
): void {
  // Only one menu at a time.
  document.querySelector(".repost-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "repost-menu";
  menu.setAttribute("role", "menu");
  const rect = anchor.getBoundingClientRect();
  menu.style.cssText = [
    "position:fixed",
    `top:${Math.round(rect.bottom + 6)}px`,
    `left:${Math.round(rect.left)}px`,
    "z-index:1000",
    "min-width:160px",
    "background:var(--surface-0)",
    "border:1px solid var(--line)",
    "border-radius:10px",
    "box-shadow:0 6px 24px rgba(0,0,0,0.18)",
    "padding:6px",
    "display:flex",
    "flex-direction:column",
    "gap:2px",
  ].join(";");

  function item(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.textContent = label;
    b.style.cssText = [
      "text-align:left",
      "padding:8px 10px",
      "border:none",
      "background:transparent",
      "border-radius:6px",
      "font-size:14px",
      "color:var(--ink-1)",
      "cursor:pointer",
    ].join(";");
    b.addEventListener("mouseenter", () => (b.style.background = "var(--surface-1, rgba(0,0,0,0.05))"));
    b.addEventListener("mouseleave", () => (b.style.background = "transparent"));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
      onClick();
    });
    return b;
  }

  function close(): void {
    menu.remove();
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function onOutside(e: MouseEvent): void {
    if (!menu.contains(e.target as Node)) close();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  menu.appendChild(item(opts.reposted ? "Undo repost" : "Repost", opts.onRepost));
  menu.appendChild(item("Quote", opts.onQuote));
  document.body.appendChild(menu);
  // Defer outside-click registration so this very click doesn't close it.
  setTimeout(() => {
    document.addEventListener("click", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

/** Inline embed of a quoted post (or a placeholder if not yet loaded). */
function createQuoteEmbed(quotedPostId: string, quoted?: Post): HTMLElement {
  const embed = document.createElement("div");
  embed.className = "post-card__quote-embed";
  embed.style.cssText = [
    "margin:8px 0 4px",
    "border:1px solid var(--line)",
    "border-radius:12px",
    "padding:10px 12px",
  ].join(";");

  if (!quoted) {
    embed.style.color = "var(--ink-3)";
    embed.style.fontSize = "13px";
    embed.textContent = `Quoted post ${quotedPostId.slice(0, 10)}… (not loaded)`;
    return embed;
  }

  const head = document.createElement("div");
  head.style.cssText = "display:flex;gap:6px;align-items:baseline;font-size:13px;margin-bottom:2px;";
  const name = document.createElement("span");
  name.style.cssText = "font-weight:600;color:var(--ink-0);";
  name.textContent = quoted.author.displayName;
  const handle = document.createElement("span");
  handle.style.cssText = "color:var(--ink-3);";
  handle.textContent = `@${quoted.author.handle}`;
  head.appendChild(name);
  head.appendChild(handle);

  const text = document.createElement("div");
  text.style.cssText = "font-size:14px;color:var(--ink-1);white-space:pre-wrap;";
  text.textContent = quoted.content;

  embed.appendChild(head);
  embed.appendChild(text);
  return embed;
}

export function createPostCard(
  post: Post,
  callbacks: PostCardCallbacks = {},
): HTMLElement {
  const article = document.createElement("article");
  article.className = "post-card";

  // Avatar column
  const avatarCol = document.createElement("div");
  avatarCol.className = "post-card__avatar-col";

  const avatar = document.createElement("div");
  avatar.className = "post-card__avatar";
  avatar.textContent = getInitials(post.author.displayName);
  if (post.author.avatarColor) {
    avatar.style.background = post.author.avatarColor;
  }

  avatarCol.appendChild(avatar);

  // Body
  const body = document.createElement("div");
  body.className = "post-card__body";

  // Meta row (name + handle + follow button + timestamp)
  const meta = document.createElement("div");
  meta.className = "post-card__meta";

  const displayName = document.createElement("span");
  displayName.className = "post-card__name";
  displayName.textContent = post.author.displayName;
  // Clicking the author name logs the pubkey (routing will be wired later)
  if (post.author.publicKey) {
    displayName.style.cssText = "cursor:pointer;";
    displayName.addEventListener("click", (e) => {
      e.stopPropagation();
      console.log(`[profile] Navigate to profile: ${post.author.displayName} (${post.author.publicKey})`);
    });
  }

  const handle = document.createElement("span");
  handle.className = "post-card__handle";
  handle.textContent = `@${post.author.handle}`;

  const timestamp = document.createElement("span");
  timestamp.className = "post-card__timestamp";
  timestamp.textContent = formatRelativeTime(post.timestamp);

  meta.appendChild(displayName);
  meta.appendChild(handle);

  // Follow button: show only if author has a publicKey and is not the current user
  const identity = getIdentity();
  const isOwnPost =
    identity && post.author.publicKey
      ? identity.publicKey === post.author.publicKey
      : false;

  // Don't show follow button if author has no publicKey or is the current user
  const showFollowBtn = Boolean(post.author.publicKey) && !isOwnPost;

  if (showFollowBtn) {
    const followBtn = document.createElement("button");
    followBtn.className = "post-card__follow-btn";
    followBtn.textContent = "Follow";
    followBtn.style.cssText = [
      "font-family:var(--font-mono)",
      "font-size:9px",
      "font-weight:400",
      "letter-spacing:0.08em",
      "text-transform:uppercase",
      "color:var(--ink-2)",
      "background:transparent",
      "border:1px solid var(--line)",
      "border-radius:7px",
      "padding:2px 8px",
      "cursor:pointer",
      "margin-left:4px",
      "transition:background 0.12s,color 0.12s,border-color 0.12s",
      "flex-shrink:0",
    ].join(";");
    followBtn.addEventListener("mouseenter", () => {
      followBtn.style.background = "var(--ink-0)";
      followBtn.style.color = "var(--surface-0)";
      followBtn.style.borderColor = "var(--ink-0)";
    });
    followBtn.addEventListener("mouseleave", () => {
      followBtn.style.background = "transparent";
      followBtn.style.color = "var(--ink-2)";
      followBtn.style.borderColor = "var(--line)";
    });
    followBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // TODO: wire to follows contract
      console.log(`[follows] Follow clicked for ${post.author.handle} (${post.author.publicKey ?? "unknown"})`);
    });
    meta.appendChild(followBtn);
  }

  meta.appendChild(timestamp);

  // Content
  const content = document.createElement("p");
  content.className = "post-card__content";
  content.textContent = post.content;

  // Action bar
  const actions = document.createElement("div");
  actions.className = "post-card__actions";

  // Mutable state (local only for now)
  let liked = post.liked ?? false;
  let likeCount = post.likes ?? 0;
  let reposted = post.reposted ?? false;
  let repostCount = post.reposts ?? 0;
  const replyCount = post.replies ?? 0;

  // Helper to build an action button
  function makeAction(
    modifier: string,
    iconHtml: string,
    count: number
  ): { btn: HTMLButtonElement; countEl: HTMLSpanElement; iconWrap: HTMLSpanElement } {
    const btn = document.createElement("button");
    btn.className = `post-action post-action--${modifier}`;

    const iconWrap = document.createElement("span");
    iconWrap.className = "post-action__icon-wrap";
    iconWrap.innerHTML = iconHtml;

    const countEl = document.createElement("span");
    countEl.className = "post-action__count";
    countEl.textContent = count > 0 ? String(count) : "";

    btn.appendChild(iconWrap);
    btn.appendChild(countEl);

    return { btn, countEl, iconWrap };
  }

  // Reply (no action, visual only)
  const reply = makeAction("reply", ICON_REPLY, replyCount);
  reply.btn.setAttribute("aria-label", "Reply");

  // Repost: the count is plain reposts + quote reposts (both amplify, matching
  // X/Threads). Clicking opens a small menu: "Repost" (optimistic toggle, count
  // reconciled via onRepostUpdated, mirroring likes) and "Quote" (opens a quote
  // composer via onQuote). The repost icon stays active while plain-reposted.
  const quoteCount = post.quotes ?? 0;
  const repostEl = makeAction("repost", ICON_REPOST, repostCount + quoteCount);
  repostEl.btn.setAttribute("aria-label", "Repost");
  repostEl.btn.setAttribute("aria-haspopup", "menu");
  if (reposted) repostEl.btn.classList.add("is-active");

  function setRepostCountLabel(): void {
    const total = repostCount + (post.quotes ?? 0);
    repostEl.countEl.textContent = total > 0 ? String(total) : "";
  }

  function doPlainRepost(): void {
    reposted = !reposted;
    repostCount += reposted ? 1 : -1;
    setRepostCountLabel();
    repostEl.btn.classList.toggle("is-active", reposted);
    callbacks.onRepost?.(post.id, reposted);
  }

  repostEl.btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Without a quote handler wired, fall back to the plain-repost toggle.
    if (!callbacks.onQuote) {
      doPlainRepost();
      return;
    }
    openRepostMenu(repostEl.btn, {
      reposted,
      onRepost: () => doPlainRepost(),
      onQuote: () => callbacks.onQuote?.(post),
    });
  });

  // Like (local toggle)
  const likeEl = makeAction("like", liked ? ICON_LIKE_FILLED : ICON_LIKE, likeCount);
  likeEl.btn.setAttribute("aria-label", "Like");
  if (liked) likeEl.btn.classList.add("is-active");
  likeEl.btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Optimistic toggle; the thread shard's authoritative count comes back via
    // onLikeUpdated and is reconciled by the feed (setPostLikeState).
    liked = !liked;
    likeCount += liked ? 1 : -1;
    likeEl.countEl.textContent = likeCount > 0 ? String(likeCount) : "";
    likeEl.btn.classList.toggle("is-active", liked);
    likeEl.iconWrap.innerHTML = liked ? ICON_LIKE_FILLED : ICON_LIKE;
    callbacks.onLike?.(post.id, liked);
  });

  // Share (no action)
  const shareEl = makeAction("share", ICON_SHARE, 0);
  shareEl.btn.setAttribute("aria-label", "Share");

  actions.appendChild(reply.btn);
  actions.appendChild(repostEl.btn);
  actions.appendChild(likeEl.btn);
  actions.appendChild(shareEl.btn);

  body.appendChild(meta);
  body.appendChild(content);

  // Quote-repost embed: if this post quotes another, render the quoted post as
  // an inline card beneath the content. Resolved from the feed via the callback;
  // if the quoted post isn't loaded yet, show a lightweight placeholder.
  if (post.quotedPostId) {
    const quoted = callbacks.resolveQuoted?.(post.quotedPostId);
    body.appendChild(createQuoteEmbed(post.quotedPostId, quoted));
  }

  body.appendChild(actions);

  article.appendChild(avatarCol);
  article.appendChild(body);

  return article;
}
