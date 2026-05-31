import { APP_NAME, APP_LOGO_URL } from "../branding";
import { toggleTheme } from "../theme";
import { getIdentity, exportIdentity } from "../identity";

export type SidebarView = "feed" | "explore" | "notifications" | "profile" | "settings";

export interface SidebarCallbacks {
  onNavigate: (view: SidebarView) => void;
  onCompose: () => void;
  /** Notification count rendered as a pill on the bell. 0 = hide. */
  notifCount?: number;
}

const ICON_HOME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
  <polyline points="9 22 9 12 15 12 15 22"/>
</svg>`;

const ICON_EXPLORE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="11" cy="11" r="7"/>
  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
</svg>`;

const ICON_BELL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
</svg>`;

const ICON_PROFILE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
  <circle cx="12" cy="7" r="4"/>
</svg>`;

const ICON_SETTINGS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="3"/>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
</svg>`;

const ICON_SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="4.5"/>
  <line x1="12" y1="2" x2="12" y2="4"/>
  <line x1="12" y1="20" x2="12" y2="22"/>
  <line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/>
  <line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/>
  <line x1="2" y1="12" x2="4" y2="12"/>
  <line x1="20" y1="12" x2="22" y2="12"/>
  <line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/>
  <line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>
</svg>`;

const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
</svg>`;

function getInitials(displayName: string): string {
  return displayName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export interface SidebarHandle extends HTMLElement {
  setActiveView: (view: SidebarView) => void;
  setNotifCount: (count: number) => void;
}

export function createSidebar(callbacks: SidebarCallbacks): SidebarHandle {
  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";

  // Wordmark
  const logo = document.createElement("a");
  logo.href = "#";
  logo.className = "sidebar-logo";
  const logoImg = document.createElement("img");
  logoImg.className = "sidebar-logo__img";
  logoImg.src = APP_LOGO_URL;
  logoImg.alt = `${APP_NAME} logo`;
  logoImg.draggable = false;
  const logoText = document.createElement("span");
  logoText.className = "sidebar-logo__text";
  logoText.textContent = APP_NAME;
  logo.appendChild(logoImg);
  logo.appendChild(logoText);
  logo.addEventListener("click", (e) => {
    e.preventDefault();
    callbacks.onNavigate("feed");
  });

  // Compose CTA — opens compose modal
  const postBtn = document.createElement("button");
  postBtn.className = "sidebar-post-btn";
  postBtn.textContent = "Compose";
  postBtn.addEventListener("click", () => callbacks.onCompose());

  // Nav
  const nav = document.createElement("nav");
  nav.className = "sidebar-nav";

  type NavSpec = { id: SidebarView; icon: string; label: string; badge?: boolean };
  const items: NavSpec[] = [
    { id: "feed", icon: ICON_HOME, label: "Home" },
    { id: "explore", icon: ICON_EXPLORE, label: "Explore" },
    { id: "notifications", icon: ICON_BELL, label: "Notifications", badge: true },
    { id: "profile", icon: ICON_PROFILE, label: "Profile" },
    { id: "settings", icon: ICON_SETTINGS, label: "Settings" },
  ];

  const navButtons = new Map<SidebarView, HTMLButtonElement>();
  let badgeEl: HTMLSpanElement | null = null;

  for (const spec of items) {
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.dataset.view = spec.id;

    const iconWrap = document.createElement("span");
    iconWrap.className = "nav-item__icon";
    iconWrap.innerHTML = spec.icon;

    const labelEl = document.createElement("span");
    labelEl.className = "nav-item__label";
    labelEl.textContent = spec.label;

    btn.appendChild(iconWrap);
    btn.appendChild(labelEl);

    if (spec.badge) {
      badgeEl = document.createElement("span");
      badgeEl.className = "nav-item__badge";
      badgeEl.style.display = "none";
      btn.appendChild(badgeEl);
    }

    btn.addEventListener("click", () => callbacks.onNavigate(spec.id));
    nav.appendChild(btn);
    navButtons.set(spec.id, btn);
  }

  // Theme toggle as ghost nav-item
  const themeToggle = document.createElement("button");
  themeToggle.className = "nav-item nav-item--theme-toggle";
  themeToggle.setAttribute("aria-label", "Toggle theme");
  const themeIcon = document.createElement("span");
  themeIcon.className = "nav-item__icon";
  const themeLabel = document.createElement("span");
  themeLabel.className = "nav-item__label";
  function refreshThemeToggle(): void {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    themeIcon.innerHTML = isDark ? ICON_SUN : ICON_MOON;
    themeLabel.textContent = isDark ? "Light mode" : "Dark mode";
  }
  refreshThemeToggle();
  themeToggle.appendChild(themeIcon);
  themeToggle.appendChild(themeLabel);
  themeToggle.addEventListener("click", () => {
    toggleTheme();
    refreshThemeToggle();
  });
  nav.appendChild(themeToggle);

  // Profile pod (clickable → profile view)
  const identity = getIdentity();
  let profileSection: HTMLElement | null = null;
  if (identity) {
    profileSection = document.createElement("div");
    profileSection.className = "sidebar-profile";
    profileSection.addEventListener("click", () => callbacks.onNavigate("profile"));

    const pAvatar = document.createElement("div");
    pAvatar.className = "sidebar-profile__avatar";
    pAvatar.textContent = getInitials(identity.displayName);

    const pInfo = document.createElement("div");
    pInfo.className = "sidebar-profile__info";

    const pName = document.createElement("div");
    pName.className = "sidebar-profile__name";
    pName.textContent = identity.displayName;

    const pHandle = document.createElement("div");
    pHandle.className = "sidebar-profile__handle";
    pHandle.textContent = `@${identity.handle}`;

    const exportLink = document.createElement("button");
    exportLink.className = "sidebar-profile__export";
    exportLink.type = "button";
    exportLink.textContent = "Export key";
    exportLink.addEventListener("click", (e) => {
      e.stopPropagation();
      exportIdentity();
    });

    pInfo.appendChild(pName);
    pInfo.appendChild(pHandle);
    pInfo.appendChild(exportLink);

    profileSection.appendChild(pAvatar);
    profileSection.appendChild(pInfo);
  }

  // Status panel
  const status = document.createElement("div");
  status.className = "sidebar-status";
  const statusLabel = document.createElement("div");
  statusLabel.className = "sidebar-section-label";
  statusLabel.textContent = "Network";
  const statusConn = document.createElement("div");
  statusConn.className = "sidebar-status__row";
  statusConn.innerHTML = `<span class="live-dot"></span><span>Connected</span>`;
  const statusKey = document.createElement("div");
  statusKey.className = "sidebar-status__row";
  if (identity?.publicKey) {
    const t = `${identity.publicKey.slice(0, 6)}…${identity.publicKey.slice(-4)}`;
    statusKey.innerHTML = `<span class="live-dot live-dot--static"></span><span>Key ${t}</span>`;
  } else {
    statusKey.innerHTML = `<span class="live-dot live-dot--static"></span><span>Anonymous</span>`;
  }
  status.appendChild(statusLabel);
  status.appendChild(statusConn);
  status.appendChild(statusKey);

  sidebar.appendChild(logo);
  sidebar.appendChild(postBtn);
  sidebar.appendChild(nav);
  if (profileSection) sidebar.appendChild(profileSection);
  sidebar.appendChild(status);

  const handle = sidebar as SidebarHandle;
  handle.setActiveView = (view: SidebarView) => {
    for (const [id, btn] of navButtons) {
      btn.classList.toggle("nav-item--active", id === view);
    }
  };
  handle.setNotifCount = (count: number) => {
    if (!badgeEl) return;
    if (count > 0) {
      badgeEl.textContent = String(count);
      badgeEl.style.display = "";
    } else {
      badgeEl.style.display = "none";
    }
  };
  handle.setActiveView("feed");
  if (callbacks.notifCount) handle.setNotifCount(callbacks.notifCount);
  return handle;
}
