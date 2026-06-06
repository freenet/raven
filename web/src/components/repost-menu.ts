// Imperative, body-appended floating repost menu — faithful 1:1 port of
// openRepostMenu() from post-card.ts. Kept as a standalone helper so the Svelte
// PostCard can mount it (Svelte portal-like) without re-implementing the DOM,
// positioning, and outside-click/Escape teardown logic.

export function openRepostMenu(
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
