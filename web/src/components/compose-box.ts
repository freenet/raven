import { Post } from "../types";

const MAX_CHARS = 280;
const WARN_THRESHOLD = 20;

interface ComposeOptions {
  placeholder?: string;
  buttonLabel?: string;
  /** When set, a read-only embed of the quoted post is shown above the footer. */
  quoted?: Post;
  /** Allow submitting with empty text (a quote post may add no comment). */
  allowEmpty?: boolean;
}

/** Standard top-of-feed composer. */
export function createComposeBox(onPost: (content: string) => void): HTMLElement {
  return buildComposer(onPost, {});
}

/** Modal composer for a quote repost: embeds the quoted post, allows empty text. */
export function createQuoteComposer(
  quoted: Post,
  onPost: (content: string) => void,
): HTMLElement {
  return buildComposer(onPost, {
    placeholder: "Add a comment…",
    buttonLabel: "Quote",
    quoted,
    allowEmpty: true,
  });
}

function buildComposer(
  onPost: (content: string) => void,
  opts: ComposeOptions,
): HTMLElement {
  const compose = document.createElement("div");
  compose.className = "compose-box";

  const avatar = document.createElement("div");
  avatar.className = "compose-box__avatar";

  const body = document.createElement("div");
  body.className = "compose-box__body";

  const textarea = document.createElement("textarea");
  textarea.className = "compose-box__textarea";
  textarea.placeholder = opts.placeholder ?? "What's happening on Freenet?";
  textarea.rows = 3;
  textarea.style.overflow = "hidden";
  textarea.style.resize = "none";

  const footer = document.createElement("div");
  footer.className = "compose-box__footer";

  const actions = document.createElement("div");
  actions.className = "compose-box__actions";

  const charCounter = document.createElement("span");
  charCounter.className = "compose-box__char-counter";
  charCounter.textContent = String(MAX_CHARS);

  const postBtn = document.createElement("button");
  postBtn.className = "btn btn--post";
  postBtn.textContent = opts.buttonLabel ?? "Post";
  // A quote (allowEmpty) starts enabled; a normal post starts disabled.
  postBtn.disabled = !opts.allowEmpty;

  function updateTextareaHeight(): void {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  function updateCounter(): void {
    const remaining = MAX_CHARS - textarea.value.length;
    charCounter.textContent = String(remaining);
    const isOverLimit = remaining < 0;
    const isNearLimit = remaining >= 0 && remaining < WARN_THRESHOLD;

    charCounter.classList.toggle("compose-box__char-counter--warn", isNearLimit);
    charCounter.classList.toggle("compose-box__char-counter--over", isOverLimit);

    const empty = textarea.value.trim().length === 0;
    postBtn.disabled = (empty && !opts.allowEmpty) || isOverLimit;
  }

  textarea.addEventListener("input", () => {
    updateTextareaHeight();
    updateCounter();
  });

  postBtn.addEventListener("click", () => {
    const content = textarea.value.trim();
    if (content.length > MAX_CHARS) return;
    if (content.length === 0 && !opts.allowEmpty) return;
    onPost(content);
    textarea.value = "";
    textarea.style.height = "auto";
    postBtn.disabled = !opts.allowEmpty;
    charCounter.textContent = String(MAX_CHARS);
    charCounter.classList.remove("compose-box__char-counter--warn", "compose-box__char-counter--over");
  });

  body.appendChild(textarea);

  // Quote embed (read-only) between the textarea and the footer.
  if (opts.quoted) {
    body.appendChild(createQuotedEmbed(opts.quoted));
  }

  actions.appendChild(charCounter);
  footer.appendChild(actions);
  footer.appendChild(postBtn);
  body.appendChild(footer);

  compose.appendChild(avatar);
  compose.appendChild(body);

  return compose;
}

/** Read-only mini-card of the post being quoted, shown inside the composer. */
function createQuotedEmbed(quoted: Post): HTMLElement {
  const embed = document.createElement("div");
  embed.style.cssText = [
    "margin:8px 0",
    "border:1px solid var(--line)",
    "border-radius:12px",
    "padding:10px 12px",
  ].join(";");

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
