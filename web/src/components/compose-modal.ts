import { Post } from "../types";
import { getIdentity } from "../identity";

const MAX_CHARS = 300;

const ICON_CLOSE = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <line x1="4" y1="4" x2="14" y2="14"/>
  <line x1="14" y1="4" x2="4" y2="14"/>
</svg>`;

const ICON_IMAGE = `<svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="3" width="13" height="11" rx="1.5"/>
  <circle cx="6" cy="7" r="1.2"/>
  <path d="M3 12l3-3 3 2 5-4"/>
</svg>`;

function getInitials(displayName: string): string {
  return displayName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export interface ComposeOptions {
  /** When set, the modal pre-renders a quoted-post mini card and uses Quote semantics. */
  quoted?: Post;
  /** Title above the textarea. Defaults differ for post vs quote. */
  label?: string;
  /** Placeholder text. */
  placeholder?: string;
  /** Submit button label. */
  buttonLabel?: string;
}

/** Open a compose modal. `onSubmit(content)` fires with trimmed text on Post click. */
export function openComposeModal(
  onSubmit: (content: string) => void,
  opts: ComposeOptions = {},
): void {
  document.querySelector(".compose-modal-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "compose-modal-overlay";

  const modal = document.createElement("div");
  modal.className = "compose-modal";
  modal.addEventListener("click", (e) => e.stopPropagation());

  // Head
  const head = document.createElement("div");
  head.className = "compose-modal__head";

  const closeBtn = document.createElement("button");
  closeBtn.className = "compose-modal__close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = ICON_CLOSE;

  const label = document.createElement("span");
  label.className = "compose-modal__label";
  label.textContent = opts.label ?? (opts.quoted ? "Quote · signed locally" : "New post · signed locally");

  const spacer = document.createElement("span");
  spacer.style.width = "28px";

  head.appendChild(closeBtn);
  head.appendChild(label);
  head.appendChild(spacer);

  // Body
  const body = document.createElement("div");
  body.className = "compose-modal__body";

  const identity = getIdentity();
  const avatar = document.createElement("div");
  avatar.className = "compose-modal__avatar";
  avatar.textContent = identity ? getInitials(identity.displayName) : "·";

  const textarea = document.createElement("textarea");
  textarea.className = "compose-modal__textarea";
  textarea.placeholder = opts.placeholder ?? (opts.quoted ? "Add a comment…" : "What's happening on the network?");
  textarea.rows = 4;

  body.appendChild(avatar);
  body.appendChild(textarea);

  // Quote embed (read-only)
  let quoteEmbed: HTMLElement | null = null;
  if (opts.quoted) {
    quoteEmbed = document.createElement("div");
    quoteEmbed.className = "compose-modal__quote";

    const qHead = document.createElement("div");
    qHead.className = "compose-modal__quote-head";

    const qName = document.createElement("span");
    qName.className = "compose-modal__quote-name";
    qName.textContent = opts.quoted.author.displayName;

    const qHandle = document.createElement("span");
    qHandle.className = "compose-modal__quote-handle";
    qHandle.textContent = `@${opts.quoted.author.handle}`;

    const qText = document.createElement("div");
    qText.className = "compose-modal__quote-text";
    qText.textContent = opts.quoted.content;

    qHead.appendChild(qName);
    qHead.appendChild(qHandle);
    quoteEmbed.appendChild(qHead);
    quoteEmbed.appendChild(qText);
  }

  // Foot
  const foot = document.createElement("div");
  foot.className = "compose-modal__foot";

  const tools = document.createElement("div");
  tools.className = "compose-modal__tools";
  const imgTool = document.createElement("button");
  imgTool.className = "compose-modal__tool";
  imgTool.setAttribute("aria-label", "Attach image");
  imgTool.innerHTML = ICON_IMAGE;
  tools.appendChild(imgTool);

  const meta = document.createElement("div");
  meta.className = "compose-modal__meta";

  const counter = document.createElement("span");
  counter.className = "compose-modal__count";
  counter.textContent = String(MAX_CHARS);

  const postBtn = document.createElement("button");
  postBtn.className = "compose-modal__post";
  postBtn.textContent = opts.buttonLabel ?? (opts.quoted ? "Quote" : "Post");
  // A quote may have no comment; a plain post must be non-empty.
  postBtn.disabled = !opts.quoted;

  meta.appendChild(counter);
  meta.appendChild(postBtn);
  foot.appendChild(tools);
  foot.appendChild(meta);

  modal.appendChild(head);
  modal.appendChild(body);
  if (quoteEmbed) modal.appendChild(quoteEmbed);
  modal.appendChild(foot);
  overlay.appendChild(modal);

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  }

  function update(): void {
    const len = textarea.value.length;
    const remaining = MAX_CHARS - len;
    counter.textContent = String(remaining);
    counter.classList.toggle("compose-modal__count--over", remaining < 0);
    const empty = textarea.value.trim().length === 0;
    postBtn.disabled = (empty && !opts.quoted) || remaining < 0;
  }

  function submit(): void {
    const content = textarea.value.trim();
    if (content.length > MAX_CHARS) return;
    if (content.length === 0 && !opts.quoted) return;
    onSubmit(content);
    close();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      close();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      submit();
    }
  }

  textarea.addEventListener("input", update);
  postBtn.addEventListener("click", submit);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);

  document.body.appendChild(overlay);
  requestAnimationFrame(() => textarea.focus());
}
