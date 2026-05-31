// Notifications screen — visual scaffold. Until the notifications data source
// lands, this renders an empty state. The masthead and tabs are wired so that
// when records arrive (likes/reposts/replies/mentions/follows), we can drop
// them in without re-doing chrome.

export interface NotificationRecord {
  id: string;
  kind: "like" | "repost" | "reply" | "mention" | "follow";
  actors: { displayName: string; handle: string; avatarColor?: string }[];
  /** Free-form relative time string. */
  ts: string;
  /** Quoted excerpt of the post being reacted to, if relevant. */
  post?: string;
  /** When the actor wrote text (reply/mention), the text itself. */
  text?: string;
}

const ICON = {
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

function namesNode(actors: NotificationRecord["actors"]): DocumentFragment {
  const f = document.createDocumentFragment();
  if (actors.length === 1) {
    const b = document.createElement("b");
    b.textContent = actors[0].displayName;
    f.appendChild(b);
  } else if (actors.length === 2) {
    const b1 = document.createElement("b");
    b1.textContent = actors[0].displayName;
    const b2 = document.createElement("b");
    b2.textContent = actors[1].displayName;
    f.append(b1, " and ", b2);
  } else {
    const b1 = document.createElement("b");
    b1.textContent = actors[0].displayName;
    const b2 = document.createElement("b");
    b2.textContent = actors[1].displayName;
    f.append(b1, ", ", b2, ` and ${actors.length - 2} others`);
  }
  return f;
}

export function createNotifications(records: NotificationRecord[] = []): HTMLElement {
  const screen = document.createElement("main");
  screen.className = "feed-column screen";

  const masthead = document.createElement("div");
  masthead.className = "masthead";
  const row = document.createElement("div");
  row.className = "masthead__row";
  const titleWrap = document.createElement("div");
  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = "Signed activity";
  const title = document.createElement("div");
  title.className = "masthead__title";
  title.textContent = "Notifications";
  titleWrap.appendChild(kicker);
  titleWrap.appendChild(title);
  row.appendChild(titleWrap);
  masthead.appendChild(row);

  const tabs = document.createElement("div");
  tabs.className = "feed-tabs";
  const tAll = document.createElement("button");
  tAll.className = "feed-tab feed-tab--on";
  tAll.textContent = "All";
  const tMentions = document.createElement("button");
  tMentions.className = "feed-tab";
  tMentions.textContent = "Mentions";
  tabs.appendChild(tAll);
  tabs.appendChild(tMentions);
  masthead.appendChild(tabs);

  screen.appendChild(masthead);

  if (records.length === 0) {
    const empty = document.createElement("div");
    empty.className = "following-note";
    empty.innerHTML = `
      <div class="following-note__title">Quiet on the network</div>
      <div class="following-note__sub">Likes, reposts, replies and follows will appear here as they sign in.</div>
    `;
    screen.appendChild(empty);
    return screen;
  }

  for (const r of records) {
    const item = document.createElement("div");
    item.className = "notif";

    const icon = document.createElement("div");
    icon.className = `notif__icon notif__icon--${r.kind}`;
    icon.innerHTML = ICON[r.kind];

    const body = document.createElement("div");
    body.className = "notif__body";

    const avs = document.createElement("div");
    avs.className = "notif__avatars";
    for (const a of r.actors) {
      const av = document.createElement("div");
      av.className = "post__avatar";
      av.style.width = "30px";
      av.style.height = "30px";
      av.style.fontSize = "12px";
      av.textContent = getInitials(a.displayName);
      if (a.avatarColor) {
        av.style.background = a.avatarColor;
        av.style.color = "#fff";
        av.style.borderColor = "transparent";
      }
      avs.appendChild(av);
    }

    const text = document.createElement("div");
    text.className = "notif__text";
    text.append(namesNode(r.actors), ` ${VERB[r.kind]}`);
    const when = document.createElement("span");
    when.className = "notif__when";
    when.textContent = r.ts;
    text.appendChild(when);

    body.appendChild(avs);
    body.appendChild(text);

    if (r.text) {
      const reply = document.createElement("div");
      reply.className = "notif__reply";
      reply.textContent = r.text;
      body.appendChild(reply);
    }
    if (r.post) {
      const excerpt = document.createElement("div");
      excerpt.className = "notif__excerpt";
      excerpt.textContent = r.post;
      body.appendChild(excerpt);
    }

    item.appendChild(icon);
    item.appendChild(body);
    screen.appendChild(item);
  }

  return screen;
}
