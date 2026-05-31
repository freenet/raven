/**
 * First-visit onboarding screen.
 * Renders a full-screen overlay asking the user for a display name.
 */

import { APP_NAME, APP_LOGO_URL } from "../branding";

export function createOnboarding(
  onComplete: (displayName: string, secretKey?: string) => void
): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "onboarding-overlay";

  const card = document.createElement("div");
  card.className = "onboarding-card";

  // App logo
  const logo = document.createElement("img");
  logo.className = "onboarding-logo";
  logo.src = APP_LOGO_URL;
  logo.alt = `${APP_NAME} logo`;
  logo.draggable = false;

  // Tagline above title
  const tagline = document.createElement("div");
  tagline.className = "onboarding-tagline";
  tagline.textContent = "Decentralized Microblog";

  const title = document.createElement("h1");
  title.className = "onboarding-title";
  title.textContent = `Welcome to ${APP_NAME}`;

  const subtitle = document.createElement("p");
  subtitle.className = "onboarding-subtitle";
  subtitle.textContent = "Choose your display name to get started";

  const input = document.createElement("input");
  input.className = "onboarding-input";
  input.type = "text";
  input.placeholder = "Your name";
  input.maxLength = 50;
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  const button = document.createElement("button");
  button.className = "onboarding-btn";
  button.textContent = "Join";
  button.disabled = true;

  input.addEventListener("input", () => {
    button.disabled = input.value.trim().length === 0;
  });

  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
    overlay.remove();
    onComplete(name);
  };

  button.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  const importLink = document.createElement("button");
  importLink.className = "onboarding-import-link";
  importLink.textContent = "Import existing identity";
  importLink.addEventListener("click", () => {
    importSection.style.display = importSection.style.display === "none" ? "flex" : "none";
    nameSection.style.display = nameSection.style.display === "none" ? "flex" : "none";
  });

  const nameSection = document.createElement("div");
  nameSection.className = "onboarding-section";
  nameSection.appendChild(input);
  nameSection.appendChild(button);

  const importSection = document.createElement("div");
  importSection.className = "onboarding-section";
  importSection.style.display = "none";

  const importInput = document.createElement("input");
  importInput.className = "onboarding-input";
  importInput.type = "text";
  importInput.placeholder = "Your name";
  importInput.maxLength = 50;

  const secretInput = document.createElement("input");
  secretInput.className = "onboarding-input onboarding-input--mono";
  secretInput.type = "password";
  secretInput.placeholder = "Secret key (64 hex characters)";
  secretInput.maxLength = 64;

  const importBtn = document.createElement("button");
  importBtn.className = "onboarding-btn";
  importBtn.textContent = "Import";
  importBtn.disabled = true;

  const checkImportReady = () => {
    importBtn.disabled = importInput.value.trim().length === 0 || secretInput.value.trim().length !== 64;
  };
  importInput.addEventListener("input", checkImportReady);
  secretInput.addEventListener("input", checkImportReady);

  importBtn.addEventListener("click", () => {
    const name = importInput.value.trim();
    const secret = secretInput.value.trim();
    if (!name || secret.length !== 64) return;
    overlay.remove();
    onComplete(name, secret);
  });

  importSection.appendChild(importInput);
  importSection.appendChild(secretInput);
  importSection.appendChild(importBtn);

  card.appendChild(logo);
  card.appendChild(tagline);
  card.appendChild(title);
  card.appendChild(subtitle);
  card.appendChild(nameSection);
  card.appendChild(importLink);
  card.appendChild(importSection);
  overlay.appendChild(card);

  requestAnimationFrame(() => input.focus());

  return overlay;
}

