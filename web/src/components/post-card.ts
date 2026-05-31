import { Post } from "../types";
import { formatRelativeTime } from "../utils";

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
  onLike?: (postId: string, liked: boolean) => void;
  onRepost?: (postId: string, reposted: boolean) => void;
  onQuote?: (post: Post) => void;
  resolveQuoted?: (postId: string) => Post | undefined;
  onOpen?: (post: Post) => void;
  /** When true, the post-text reads at "lead" size — used for the top of feed. */
  lead?: boolean;
}

function openRepostMenu(
  anchor: HTMLElement,
  opts: { reposted: boolean; onRepost: () => void; onQuote: () => void },
): void {
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
    "background:var(--bg-elevated)",
    "border:1px solid var(--line)",
    "border-radius:10px",
    "box-shadow:var(--shadow-md)",
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
    b.addEventListener("mouseenter", () => (b.style.background = "var(--surface-hover)"));
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
  setTimeout(() => {
    document.addEventListener("click", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

function createQuoteEmbed(quotedPostId: string, quoted?: Post): HTMLElement {
  const embed = document.createElement("div");
  embed.className = "post__quote-embed";

  if (!quoted) {
    embed.textContent = `Quoted post ${quotedPostId.slice(0, 10)}… (not loaded)`;
    embed.style.color = "var(--ink-3)";
    embed.style.fontSize = "13px";
    return embed;
  }

  const head = document.createElement("div");
  head.className = "post__quote-embed-head";

  const name = document.createElement("span");
  name.className = "post__quote-embed-name";
  name.textContent = quoted.author.displayName;

  const handle = document.createElement("span");
  handle.className = "post__quote-embed-handle";
  handle.textContent = `@${quoted.author.handle}`;

  const text = document.createElement("div");
  text.className = "post__quote-embed-text";
  text.textContent = quoted.content;

  head.appendChild(name);
  head.appendChild(handle);
  embed.appendChild(head);
  embed.appendChild(text);
  return embed;
}

export function createPostCard(
  post: Post,
  callbacks: PostCardCallbacks = {},
): HTMLElement {
  const article = document.createElement("article");
  article.className = "post";
  article.addEventListener("click", () => callbacks.onOpen?.(post));

  // Repost context line (above byline when current user reposted)
  if (post.reposted) {
    const ctx = document.createElement("div");
    ctx.className = "post__repost-ctx";
    ctx.innerHTML = `${ICON_REPOST} <span>You reposted</span>`;
    article.appendChild(ctx);
  }

  // Byline (avatar + name + meta)
  const byline = document.createElement("div");
  byline.className = "post__byline";

  const avatar = document.createElement("div");
  avatar.className = "post__avatar";
  avatar.textContent = getInitials(post.author.displayName);
  if (post.author.avatarColor) {
    avatar.style.background = post.author.avatarColor;
    avatar.style.color = "#fff";
    avatar.style.borderColor = "transparent";
  }

  const who = document.createElement("div");
  who.className = "post__who";

  const name = document.createElement("span");
  name.className = "post__name";
  name.textContent = post.author.displayName;

  const when = document.createElement("span");
  when.className = "post__when";
  when.innerHTML = `@${post.author.handle}<i>·</i>${formatRelativeTime(post.timestamp)}`;

  who.appendChild(name);
  who.appendChild(when);

  byline.appendChild(avatar);
  byline.appendChild(who);
  article.appendChild(byline);

  // Body text
  const text = document.createElement("p");
  text.className = callbacks.lead ? "post__text post__text--lead" : "post__text";
  text.textContent = post.content;
  article.appendChild(text);

  // Quote embed (when this post quotes another)
  if (post.quotedPostId) {
    const quoted = callbacks.resolveQuoted?.(post.quotedPostId);
    article.appendChild(createQuoteEmbed(post.quotedPostId, quoted));
  }

  // Action row
  const foot = document.createElement("div");
  foot.className = "post__foot";
  foot.addEventListener("click", (e) => e.stopPropagation());

  const rule = document.createElement("div");
  rule.className = "post__rule";
  foot.appendChild(rule);

  // Like state (optimistic)
  let liked = post.liked ?? false;
  let likeCount = post.likes ?? 0;
  const likeBtn = document.createElement("button");
  likeBtn.className = "post-act post-act--like";
  if (liked) likeBtn.classList.add("is-active");
  likeBtn.setAttribute("aria-label", "Like");
  likeBtn.innerHTML = `${liked ? ICON_LIKE_FILLED : ICON_LIKE}<span>${likeCount > 0 ? likeCount : ""}</span>`;
  likeBtn.addEventListener("click", () => {
    liked = !liked;
    likeCount += liked ? 1 : -1;
    likeBtn.classList.toggle("is-active", liked);
    likeBtn.innerHTML = `${liked ? ICON_LIKE_FILLED : ICON_LIKE}<span>${likeCount > 0 ? likeCount : ""}</span>`;
    callbacks.onLike?.(post.id, liked);
  });

  // Reply (opens thread view via onOpen)
  const replyBtn = document.createElement("button");
  replyBtn.className = "post-act post-act--reply";
  replyBtn.setAttribute("aria-label", "Reply");
  replyBtn.innerHTML = `${ICON_REPLY}<span>${(post.replies ?? 0) > 0 ? post.replies : ""}</span>`;
  replyBtn.addEventListener("click", () => callbacks.onOpen?.(post));

  // Repost: menu → plain repost or quote
  let reposted = post.reposted ?? false;
  let repostCount = post.reposts ?? 0;
  const quoteCount = post.quotes ?? 0;
  const repostBtn = document.createElement("button");
  repostBtn.className = "post-act post-act--repost";
  if (reposted) repostBtn.classList.add("is-active");
  repostBtn.setAttribute("aria-label", "Repost");
  repostBtn.setAttribute("aria-haspopup", "menu");
  function renderRepost(): void {
    const total = repostCount + quoteCount;
    repostBtn.innerHTML = `${ICON_REPOST}<span>${total > 0 ? total : ""}</span>`;
  }
  renderRepost();
  function doPlainRepost(): void {
    reposted = !reposted;
    repostCount += reposted ? 1 : -1;
    repostBtn.classList.toggle("is-active", reposted);
    renderRepost();
    callbacks.onRepost?.(post.id, reposted);
  }
  repostBtn.addEventListener("click", () => {
    if (!callbacks.onQuote) {
      doPlainRepost();
      return;
    }
    openRepostMenu(repostBtn, {
      reposted,
      onRepost: doPlainRepost,
      onQuote: () => callbacks.onQuote?.(post),
    });
  });

  const shareBtn = document.createElement("button");
  shareBtn.className = "post-act post-act--share";
  shareBtn.setAttribute("aria-label", "Share");
  shareBtn.innerHTML = ICON_SHARE;

  foot.appendChild(likeBtn);
  foot.appendChild(replyBtn);
  foot.appendChild(repostBtn);
  foot.appendChild(shareBtn);
  article.appendChild(foot);

  return article;
}
