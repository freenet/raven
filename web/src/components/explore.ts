// Explore screen — visual scaffold. Trending data lands once discovery (#13)
// wires through. For now the search input filters client-side over an empty list.

const ICON_SEARCH = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="11" cy="11" r="7"/>
  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
</svg>`;

export interface ExploreItem {
  category: string;
  topic: string;
  count: string;
}

export function createExplore(items: ExploreItem[] = []): HTMLElement {
  const screen = document.createElement("main");
  screen.className = "feed-column screen";

  const masthead = document.createElement("div");
  masthead.className = "masthead";
  const row = document.createElement("div");
  row.className = "masthead__row";
  const titleWrap = document.createElement("div");
  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = "The Network · Discover";
  const title = document.createElement("div");
  title.className = "masthead__title";
  title.textContent = "Explore";
  titleWrap.appendChild(kicker);
  titleWrap.appendChild(title);
  row.appendChild(titleWrap);
  masthead.appendChild(row);

  const tabs = document.createElement("div");
  tabs.className = "feed-tabs";
  const tab = document.createElement("button");
  tab.className = "feed-tab feed-tab--on";
  tab.textContent = "Trending";
  tabs.appendChild(tab);
  masthead.appendChild(tabs);

  const search = document.createElement("div");
  search.className = "explore-search";
  const icon = document.createElement("span");
  icon.className = "explore-search__icon";
  icon.innerHTML = ICON_SEARCH;
  const input = document.createElement("input");
  input.className = "explore-search__input";
  input.placeholder = "Search topics, people, keys";
  search.appendChild(icon);
  search.appendChild(input);

  const list = document.createElement("div");
  list.className = "explore-list";

  function render(query: string): void {
    list.innerHTML = "";
    const q = query.trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (e) =>
            e.topic.toLowerCase().includes(q) ||
            e.category.toLowerCase().includes(q),
        )
      : items;

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = q ? "screen-empty" : "following-note";
      if (q) {
        empty.textContent = `No topics match "${query}".`;
      } else {
        empty.innerHTML = `
          <div class="following-note__title">No trending topics yet</div>
          <div class="following-note__sub">Topics will surface here once discovery indexing comes online.</div>
        `;
      }
      list.appendChild(empty);
      return;
    }

    filtered.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "explore-item";
      const rank = document.createElement("div");
      rank.className = "explore-item__rank";
      rank.textContent = String(i + 1);
      const body = document.createElement("div");
      body.className = "explore-item__body";
      const cat = document.createElement("span");
      cat.className = "explore-item__cat";
      cat.textContent = item.category;
      const topic = document.createElement("span");
      topic.className = "explore-item__topic";
      topic.textContent = item.topic;
      const count = document.createElement("span");
      count.className = "explore-item__count";
      count.textContent = item.count;
      body.appendChild(cat);
      body.appendChild(topic);
      body.appendChild(count);
      row.appendChild(rank);
      row.appendChild(body);
      list.appendChild(row);
    });
  }

  input.addEventListener("input", () => render(input.value));

  screen.appendChild(masthead);
  screen.appendChild(search);
  screen.appendChild(list);
  render("");
  return screen;
}
