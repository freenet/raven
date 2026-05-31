import { SidebarView } from "./sidebar";

export interface RightPanelCallbacks {
  onNavigate?: (view: SidebarView) => void;
}

export function createRightPanel(cb: RightPanelCallbacks = {}): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "right-panel";

  // Search → opens explore
  const searchBox = document.createElement("div");
  searchBox.className = "search-box";
  searchBox.style.cursor = "pointer";

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "search-box__input";
  searchInput.placeholder = "Search Raven";
  searchInput.setAttribute("aria-label", "Search");
  searchInput.readOnly = true;

  const searchIcon = document.createElement("span");
  searchIcon.className = "search-box__icon";
  searchIcon.textContent = "⌕";

  searchBox.appendChild(searchInput);
  searchBox.appendChild(searchIcon);
  searchBox.addEventListener("click", () => cb.onNavigate?.("explore"));

  // Network strip
  const strip = document.createElement("div");
  strip.className = "info-strip";
  strip.innerHTML = `
    <span class="info-strip__label">Network</span>
    <span class="info-strip__content">P2P · encrypted</span>
    <span class="info-strip__badge">✓ live</span>
  `;

  // Trending (empty scaffold)
  const trending = document.createElement("div");
  trending.className = "panel-card";
  trending.innerHTML = `
    <div class="panel-card__header">
      <div class="panel-card__title">Trending on Freenet</div>
      <div class="panel-card__subtitle">Discovery in progress</div>
    </div>
  `;
  const trendBody = document.createElement("div");
  trendBody.style.cssText = "padding:14px 16px;font-family:var(--font-body);font-size:13px;color:var(--ink-3);line-height:1.5;";
  trendBody.textContent = "Topics will surface here once discovery indexing comes online.";
  trending.appendChild(trendBody);
  const trendMore = document.createElement("a");
  trendMore.className = "panel-card__more";
  trendMore.textContent = "Open explore";
  trendMore.style.cursor = "pointer";
  trendMore.addEventListener("click", () => cb.onNavigate?.("explore"));
  trending.appendChild(trendMore);

  // Who to follow (empty scaffold)
  const follows = document.createElement("div");
  follows.className = "panel-card";
  follows.innerHTML = `
    <div class="panel-card__header">
      <div class="panel-card__title">Who to follow</div>
      <div class="panel-card__subtitle">On the network</div>
    </div>
  `;
  const followBody = document.createElement("div");
  followBody.style.cssText = "padding:14px 16px;font-family:var(--font-body);font-size:13px;color:var(--ink-3);line-height:1.5;";
  followBody.textContent = "Suggestions appear once you start following or post content others react to.";
  follows.appendChild(followBody);

  // About
  const about = document.createElement("div");
  about.className = "panel-card";
  about.innerHTML = `
    <div class="panel-card__header">
      <div class="panel-card__title">About Freenet</div>
      <div class="panel-card__subtitle">Decentralized · P2P</div>
    </div>
  `;
  const aboutBody = document.createElement("div");
  aboutBody.style.cssText = "padding:14px 16px 16px;display:flex;flex-direction:column;gap:12px;";
  const desc = document.createElement("p");
  desc.style.cssText = "font-family:var(--font-body);font-size:13px;color:var(--ink-2);line-height:1.6;letter-spacing:-0.005em;";
  desc.textContent = "A decentralized social network. Your data, your keys, your control. No servers, no trackers.";
  const link = document.createElement("a");
  link.href = "https://freenet.org";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "freenet.org →";
  link.style.cssText = "font-family:var(--font-mono);font-size:9.5px;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);text-decoration:none;";
  aboutBody.appendChild(desc);
  aboutBody.appendChild(link);
  about.appendChild(aboutBody);

  panel.appendChild(searchBox);
  panel.appendChild(strip);
  panel.appendChild(trending);
  panel.appendChild(follows);
  panel.appendChild(about);
  return panel;
}
