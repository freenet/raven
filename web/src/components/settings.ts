import { toggleTheme } from "../theme";
import { getIdentity, exportIdentity, Identity } from "../identity";

function truncateKey(key: string): string {
  if (key.length <= 26) return key;
  return `${key.slice(0, 14)}…${key.slice(-8)}`;
}

function row(label: string, desc: string | null, control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "settings-row";
  const main = document.createElement("div");
  main.className = "settings-row__main";
  const lab = document.createElement("div");
  lab.className = "settings-row__label";
  lab.textContent = label;
  main.appendChild(lab);
  if (desc) {
    const d = document.createElement("div");
    d.className = "settings-row__desc";
    d.textContent = desc;
    main.appendChild(d);
  }
  r.appendChild(main);
  r.appendChild(control);
  return r;
}

function section(title: string, sub: string): HTMLElement {
  const sec = document.createElement("div");
  sec.className = "settings-section";
  const t = document.createElement("div");
  t.className = "settings-section__title";
  t.textContent = title;
  const s = document.createElement("div");
  s.className = "settings-section__sub";
  s.textContent = sub;
  sec.appendChild(t);
  sec.appendChild(s);
  return sec;
}

function list(...rows: HTMLElement[]): HTMLElement {
  const l = document.createElement("div");
  l.className = "settings-list";
  for (const r of rows) l.appendChild(r);
  return l;
}

function value(text: string): HTMLElement {
  const v = document.createElement("span");
  v.className = "settings-row__value";
  v.textContent = text;
  return v;
}

function toggle(initial: boolean, onChange: (v: boolean) => void): HTMLElement {
  const btn = document.createElement("button");
  btn.className = initial ? "toggle-switch on" : "toggle-switch";
  btn.setAttribute("aria-pressed", String(initial));
  const knob = document.createElement("span");
  knob.className = "toggle-switch__knob";
  btn.appendChild(knob);
  let state = initial;
  btn.addEventListener("click", () => {
    state = !state;
    btn.classList.toggle("on", state);
    btn.setAttribute("aria-pressed", String(state));
    onChange(state);
  });
  return btn;
}

function segmented<T extends string>(
  active: T,
  options: { v: T; label: string }[],
  onChange: (v: T) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "segmented";
  const btns: HTMLButtonElement[] = [];
  let current: T = active;
  for (const opt of options) {
    const b = document.createElement("button");
    b.className = opt.v === active ? "segmented__btn on" : "segmented__btn";
    b.textContent = opt.label;
    b.addEventListener("click", () => {
      if (opt.v === current) return;
      current = opt.v;
      for (const x of btns) x.classList.remove("on");
      b.classList.add("on");
      onChange(opt.v);
    });
    btns.push(b);
    wrap.appendChild(b);
  }
  return wrap;
}

function currentTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function currentSize(): "small" | "regular" | "large" {
  const s = document.documentElement.dataset.size;
  return s === "small" || s === "large" ? s : "regular";
}

export function createSettings(): HTMLElement {
  const identity: Identity | null = getIdentity();
  const screen = document.createElement("main");
  screen.className = "feed-column screen settings";

  // Masthead
  const masthead = document.createElement("div");
  masthead.className = "masthead";
  const mrow = document.createElement("div");
  mrow.className = "masthead__row";
  const titleWrap = document.createElement("div");
  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = "Your account · Your keys";
  const title = document.createElement("div");
  title.className = "masthead__title";
  title.textContent = "Settings";
  titleWrap.appendChild(kicker);
  titleWrap.appendChild(title);
  mrow.appendChild(titleWrap);
  masthead.appendChild(mrow);
  screen.appendChild(masthead);

  // ── Account ──
  screen.appendChild(section("Account & identity", "Signed with a post-quantum key, held on your device"));
  screen.appendChild(
    list(
      row("Display name", null, value(identity?.displayName ?? "—")),
      row("Handle", null, value(identity ? `@${identity.handle}` : "—")),
      row(
        "Discoverable on the network",
        "Let others find you by handle in Explore",
        toggle(true, () => undefined),
      ),
    ),
  );

  if (identity?.publicKey) {
    const keyrow = document.createElement("div");
    keyrow.className = "settings-keyrow";
    const lab = document.createElement("span");
    lab.className = "settings-keyrow__label";
    lab.textContent = "ML-DSA-65";
    const key = document.createElement("span");
    key.className = "settings-keyrow__key";
    key.textContent = truncateKey(identity.publicKey);
    const exp = document.createElement("button");
    exp.className = "settings-export";
    exp.textContent = "Export key";
    exp.addEventListener("click", () => exportIdentity());
    keyrow.appendChild(lab);
    keyrow.appendChild(key);
    keyrow.appendChild(exp);
    screen.appendChild(keyrow);
  }

  // ── Appearance ──
  screen.appendChild(section("Appearance", "How Raven reads on your screen"));
  screen.appendChild(
    list(
      row(
        "Theme",
        "Light is the primary theme; dark is a deep-slate variant",
        segmented<"light" | "dark">(
          currentTheme(),
          [
            { v: "light", label: "Light" },
            { v: "dark", label: "Dark" },
          ],
          (v) => {
            const isDark = document.documentElement.getAttribute("data-theme") === "dark";
            if ((v === "dark") !== isDark) toggleTheme();
          },
        ),
      ),
      row(
        "Reading size",
        "Body text scale across the feed and threads",
        segmented<"small" | "regular" | "large">(
          currentSize(),
          [
            { v: "small", label: "Small" },
            { v: "regular", label: "Default" },
            { v: "large", label: "Large" },
          ],
          (v) => {
            document.documentElement.dataset.size = v;
          },
        ),
      ),
    ),
  );

  // ── Network ──
  screen.appendChild(section("Network", "What the decentralized layer shows you"));
  screen.appendChild(
    list(
      row("Show routing & provenance", "Hop trails and signed marks on every post", toggle(true, () => undefined)),
      row("Relay for the network", "Cache and forward records for nearby peers", toggle(false, () => undefined)),
    ),
  );

  // ── Notifications ──
  screen.appendChild(section("Notifications", "Choose what reaches you"));
  screen.appendChild(
    list(
      row("Mentions & replies", null, toggle(true, () => undefined)),
      row("Likes", null, toggle(true, () => undefined)),
      row("Reposts", null, toggle(false, () => undefined)),
      row("New followers", null, toggle(true, () => undefined)),
    ),
  );

  // ── Privacy ──
  screen.appendChild(section("Privacy & data", "You own it. The network only caches it."));
  const exportBtn = document.createElement("button");
  exportBtn.className = "settings-export";
  exportBtn.textContent = "Export key";
  exportBtn.addEventListener("click", () => exportIdentity());
  const signOut = document.createElement("button");
  signOut.className = "settings-danger";
  signOut.textContent = "Sign out";
  screen.appendChild(
    list(
      row("Export your identity key", "Back up your secret key to restore on another device", exportBtn),
      row("Sign out", "Your posts stay on the network; your key leaves this device", signOut),
    ),
  );

  return screen;
}
