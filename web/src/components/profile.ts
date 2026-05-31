import { Post, User } from "../types";
import { createPostCard, PostCardCallbacks } from "./post-card";

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

export interface ProfileCallbacks extends PostCardCallbacks {
  onSettings?: () => void;
  /** Optional bio + counts shown alongside the editorial header. */
  bio?: string;
  following?: number;
  followers?: number;
}

export function createProfile(
  user: User,
  posts: Post[],
  cb: ProfileCallbacks = {},
): HTMLElement {
  const screen = document.createElement("main");
  screen.className = "feed-column screen";

  // Masthead
  const masthead = document.createElement("div");
  masthead.className = "masthead";
  const row = document.createElement("div");
  row.className = "masthead__row";
  const titleWrap = document.createElement("div");
  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = `Identity · ${posts.length} ${posts.length === 1 ? "post" : "posts"}`;
  const title = document.createElement("div");
  title.className = "masthead__title";
  title.textContent = user.displayName;
  titleWrap.appendChild(kicker);
  titleWrap.appendChild(title);
  row.appendChild(titleWrap);
  masthead.appendChild(row);

  // Header
  const header = document.createElement("div");
  header.className = "profile-header";

  const top = document.createElement("div");
  top.className = "profile-header__top";

  const avatar = document.createElement("div");
  avatar.className = "profile-header__avatar";
  avatar.textContent = getInitials(user.displayName);
  if (user.avatarColor) {
    avatar.style.background = user.avatarColor;
    avatar.style.color = "#fff";
    avatar.style.borderColor = "transparent";
  }

  const edit = document.createElement("button");
  edit.className = "profile-edit";
  edit.textContent = "Edit profile";
  edit.addEventListener("click", () => cb.onSettings?.());

  top.appendChild(avatar);
  top.appendChild(edit);

  const name = document.createElement("div");
  name.className = "profile-header__name";
  name.textContent = user.displayName;

  const handle = document.createElement("div");
  handle.className = "profile-header__handle";
  handle.textContent = `@${user.handle}`;

  header.appendChild(top);
  header.appendChild(name);
  header.appendChild(handle);

  if (cb.bio) {
    const bio = document.createElement("p");
    bio.className = "profile-header__bio";
    bio.textContent = cb.bio;
    header.appendChild(bio);
  }

  const stats = document.createElement("div");
  stats.className = "profile-stats";
  const triplets: [number, string][] = [
    [posts.length, "Posts"],
    [cb.following ?? 0, "Following"],
    [cb.followers ?? 0, "Followers"],
  ];
  for (const [n, label] of triplets) {
    const stat = document.createElement("div");
    stat.className = "profile-stat";
    const num = document.createElement("span");
    num.className = "profile-stat__num";
    num.textContent = String(n);
    const lab = document.createElement("span");
    lab.className = "profile-stat__label";
    lab.textContent = label;
    stat.appendChild(num);
    stat.appendChild(lab);
    stats.appendChild(stat);
  }
  header.appendChild(stats);

  if (user.publicKey) {
    const keyrow = document.createElement("div");
    keyrow.className = "profile-keyrow";
    const lab = document.createElement("span");
    lab.className = "profile-keyrow__label";
    lab.textContent = "ML-DSA-65";
    const key = document.createElement("span");
    key.className = "profile-keyrow__key";
    key.textContent = truncateKey(user.publicKey);
    const badge = document.createElement("span");
    badge.className = "info-strip__badge";
    badge.style.marginLeft = "auto";
    badge.textContent = "✓ verified";
    keyrow.appendChild(lab);
    keyrow.appendChild(key);
    keyrow.appendChild(badge);
    header.appendChild(keyrow);
  }

  // Posts list
  const rhead = document.createElement("div");
  rhead.className = "thread-rhead";
  rhead.innerHTML = `<span>Your posts</span>`;
  rhead.style.paddingTop = "20px";

  screen.appendChild(masthead);
  screen.appendChild(header);
  screen.appendChild(rhead);

  if (posts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "screen-empty";
    empty.textContent = "Nothing posted yet.";
    screen.appendChild(empty);
  } else {
    const resolveQuoted = (id: string): Post | undefined => posts.find((p) => p.id === id);
    for (const post of posts) {
      screen.appendChild(
        createPostCard(post, {
          onLike: cb.onLike,
          onRepost: cb.onRepost,
          onQuote: cb.onQuote,
          onOpen: cb.onOpen,
          resolveQuoted,
        }),
      );
    }
  }

  return screen;
}
