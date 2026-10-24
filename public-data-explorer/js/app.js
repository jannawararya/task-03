/*
 * Repository Explorer
 * Searches public GitHub repositories through the GitHub REST API.
 * No framework, no build step. API text is only ever written with textContent,
 * never innerHTML, so repository descriptions cannot inject markup.
 */
(() => {
  "use strict";

  // ------------------------------------------------------------------ config
  const API_URL = "https://api.github.com/search/repositories";
  const PER_PAGE = 30;
  const MAX_VISIBLE_RESULTS = 1000; // GitHub only exposes the first 1,000 matches of a search
  const SORTS = ["best", "stars", "updated", "name"];
  const SUGGESTIONS = ["machine learning", "web scraper", "flutter app", "react dashboard"];

  const LANGUAGE_COLORS = {
    Python: "#3572a5", JavaScript: "#d4b106", TypeScript: "#3178c6", Java: "#b07219",
    "C++": "#f34b7d", C: "#6e6e6e", "C#": "#178600", Go: "#00add8", Rust: "#c9885f",
    Ruby: "#a91e50", PHP: "#4f5d95", Swift: "#f05138", Kotlin: "#a97bff", Dart: "#00b4ab",
    HTML: "#e34c26", CSS: "#7a52b3", Shell: "#5fb02e", "Jupyter Notebook": "#da5b0b",
  };
  const FALLBACK_COLOR = "#8b87a3";

  const ICONS = {
    star: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l2.1 4.3 4.7.6-3.4 3.3.8 4.7L8 12.2 3.8 14.4l.8-4.7L1.2 6.4l4.7-.6z"/></svg>',
    fork: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.7"/><circle cx="12" cy="3.5" r="1.7"/><circle cx="8" cy="12.5" r="1.7"/><path d="M4 5.2v1.3c0 1 .8 1.8 1.8 1.8h4.4c1 0 1.8-.8 1.8-1.8V5.2M8 8.3v2.5"/></svg>',
    clock: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.3 1.5"/></svg>',
  };

  // ------------------------------------------------------------------- state
  const state = {
    query: "",      // last submitted search
    lang: "",
    sort: "best",
    page: 0,        // last page successfully loaded
    items: [],
    total: 0,
    incomplete: false,
    loading: false,
    hasSearched: false,
  };
  let inflight = null;      // AbortController of the current request
  let requestCounter = 0;   // lets us ignore responses from outdated requests
  let lastAction = null;    // what the "Try again" button repeats

  // --------------------------------------------------------------------- DOM
  const $ = (id) => document.getElementById(id);
  const form = $("search-form");
  const qInput = $("q");
  const langSelect = $("lang");
  const sortSelect = $("sort");
  const statusEl = $("status");
  const errorEl = $("error");
  const suggestionsEl = $("suggestions");
  const emptyEl = $("empty");
  const resultsEl = $("results");
  const moreBtn = $("load-more");
  const rateEl = $("rate-info");
  const themeBtn = $("theme-toggle");

  // ----------------------------------------------------------------- helpers
  /** Create an element. Text is always set via textContent. */
  function el(tag, { className, text, attrs } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const child of children) node.append(child);
    return node;
  }

  /** Static, trusted SVG strings only (never API data). */
  function icon(name) {
    const wrapper = document.createElement("span");
    wrapper.innerHTML = ICONS[name];
    return wrapper.firstElementChild;
  }

  const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  const fullNumber = new Intl.NumberFormat("en");
  const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const UNITS = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];

  function timeAgo(iso, now = Date.now()) {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "at an unknown time";
    const diff = (then - now) / 1000;
    for (const [unit, seconds] of UNITS) {
      if (Math.abs(diff) >= seconds) return relativeTime.format(Math.round(diff / seconds), unit);
    }
    return "just now";
  }

  function languageColor(language) {
    return LANGUAGE_COLORS[language] || FALLBACK_COLOR;
  }

  /** Build GitHub's search expression, e.g.  `machine learning language:"Jupyter Notebook"` */
  function buildSearchQuery(query, lang) {
    const language = lang ? `language:${/\s/.test(lang) ? `"${lang}"` : lang}` : "";
    return [query.trim(), language].filter(Boolean).join(" ");
  }

  /** Bar width (%) on a log scale, so one giant repo doesn't flatten everything else. */
  function starBarWidth(stars, maxStars) {
    if (maxStars <= 0) return 0;
    return Math.max(2, (Math.log10(stars + 1) / Math.log10(maxStars + 1)) * 100);
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  // ------------------------------------------------------------------- theme
  function applyTheme(theme, persist) {
    document.documentElement.setAttribute("data-theme", theme);
    themeBtn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    if (persist) {
      try { localStorage.setItem("theme", theme); } catch (e) { /* storage may be blocked */ }
    }
  }

  // ------------------------------------------------------------------ API
  class ApiError extends Error {
    constructor(kind, message, extra = {}) {
      super(message);
      this.kind = kind;
      Object.assign(this, extra);
    }
  }

  function headerInt(headers, name) {
    const raw = headers.get(name);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  }

  function readRateLimit(headers) {
    return {
      limit: headerInt(headers, "x-ratelimit-limit"),
      remaining: headerInt(headers, "x-ratelimit-remaining"),
      reset: headerInt(headers, "x-ratelimit-reset"),
    };
  }

  async function toApiError(res, rate) {
    let detail = "";
    try {
      const body = await res.json();
      if (typeof body.message === "string") detail = body.message;
    } catch (e) { /* non-JSON error body */ }

    const rateLimited = res.status === 429 || (res.status === 403 && (rate.remaining === 0 || /rate limit/i.test(detail)));
    if (rateLimited) {
      const retryAfter = headerInt(res.headers, "retry-after");
      const untilReset = rate.reset ? Math.max(0, rate.reset - Math.floor(Date.now() / 1000)) : null;
      const wait = retryAfter ?? untilReset;
      const when = wait ? ` Try again in ${plural(wait, "second")}.` : " Wait a minute, then try again.";
      return new ApiError("rate_limit", `You’ve reached GitHub’s limit for searches without a login (10 per minute).${when}`);
    }
    if (res.status === 422) {
      return new ApiError("invalid", "GitHub couldn’t run that search. Try different keywords or remove special characters.");
    }
    if (res.status >= 500) {
      return new ApiError("server", "GitHub is having trouble right now. Try again in a moment.");
    }
    return new ApiError("http", `GitHub returned an unexpected error (status ${res.status}).`);
  }

  async function fetchRepos({ query, lang, sort, page, signal }) {
    const params = new URLSearchParams({
      q: buildSearchQuery(query, lang),
      per_page: String(PER_PAGE),
      page: String(page),
    });
    if (sort === "stars" || sort === "updated") {
      params.set("sort", sort);
      params.set("order", "desc");
    }

    let res;
    try {
      res = await fetch(`${API_URL}?${params}`, { signal, headers: { Accept: "application/vnd.github+json" } });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new ApiError("network", "Can’t reach GitHub. Check your internet connection and try again.");
    }

    const rate = readRateLimit(res.headers);
    if (!res.ok) throw await toApiError(res, rate);

    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new ApiError("http", "GitHub sent a response this page couldn’t read. Try again.");
    }
    return {
      items: Array.isArray(data.items) ? data.items : [],
      total: Number(data.total_count) || 0,
      incomplete: Boolean(data.incomplete_results),
      rate,
    };
  }

  // --------------------------------------------------------------- rendering
  function setStatus(text) {
    statusEl.textContent = text;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.replaceChildren();
    qInput.removeAttribute("aria-invalid");
  }

  function showError(message, { retry = false } = {}) {
    const children = [el("p", { text: message })];
    if (retry && lastAction) {
      const btn = el("button", { className: "btn", text: "Try again", attrs: { type: "button" } });
      btn.addEventListener("click", () => lastAction());
      children.push(btn);
    }
    errorEl.replaceChildren(...children);
    errorEl.hidden = false;
  }

  function renderSuggestions() {
    const list = suggestionsEl.querySelector(".chips");
    list.replaceChildren(
      ...SUGGESTIONS.map((term) => {
        const btn = el("button", { className: "chip", text: term, attrs: { type: "button" } });
        btn.addEventListener("click", () => {
          qInput.value = term;
          startSearch({ push: true });
        });
        return el("li", {}, [btn]);
      })
    );
  }

  function renderSkeletons(count = 6) {
    resultsEl.setAttribute("aria-busy", "true");
    resultsEl.replaceChildren(
      ...Array.from({ length: count }, () =>
        el("li", { className: "card card--skeleton", attrs: { "aria-hidden": "true" } }, [
          el("span", { className: "sk sk--title" }),
          el("span", { className: "sk" }),
          el("span", { className: "sk" }),
          el("span", { className: "sk sk--short" }),
        ])
      )
    );
  }

  function statItem(iconName, text, { title, srLabel, className } = {}) {
    const item = el("span", { className: `stat ${className || ""}`.trim() });
    if (title) item.title = title;
    item.append(icon(iconName), el("span", { text }));
    if (srLabel) item.append(el("span", { className: "sr-only", text: srLabel }));
    return item;
  }

  function renderCard(repo, maxStars) {
    const card = el("li", { className: "card" });
    card.style.setProperty("--lang", languageColor(repo.language));

    // Header: avatar, name (the single link), owner
    const avatar = el("img", {
      className: "avatar",
      attrs: { alt: "", width: "36", height: "36", loading: "lazy" },
    });
    if (repo.owner && repo.owner.avatar_url) avatar.src = `${repo.owner.avatar_url}&s=72`;

    const link = el("a", {
      text: repo.name,
      attrs: {
        href: repo.html_url,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": `${repo.full_name}, opens on GitHub in a new tab`,
      },
    });
    const head = el("div", { className: "card__head" }, [
      avatar,
      el("div", { className: "card__id" }, [
        el("h2", { className: "card__title" }, [link]),
        el("p", { className: "card__owner", text: repo.owner ? repo.owner.login : "" }),
      ]),
    ]);

    // Description
    const desc = repo.description
      ? el("p", { className: "card__desc", text: repo.description })
      : el("p", { className: "card__desc card__desc--none", text: "No description provided." });

    // Topics and archived tag
    const tags = [];
    if (repo.archived) tags.push(el("li", { className: "tag-archived", text: "Archived" }));
    (repo.topics || []).slice(0, 3).forEach((t) => tags.push(el("li", { text: t })));

    // Footer: relative star bar + stats
    const bar = el("div", { className: "star-bar", attrs: { "aria-hidden": "true" } }, [el("span")]);
    bar.firstElementChild.style.width = `${starBarWidth(repo.stargazers_count || 0, maxStars)}%`;

    const stats = el("p", { className: "stats" });
    if (repo.language) {
      const lang = el("span", { className: "stat stat--lang" }, [el("span", { className: "dot" }), el("span", { text: repo.language })]);
      stats.append(lang);
    }
    stats.append(
      statItem("star", compactNumber.format(repo.stargazers_count || 0), {
        title: `${fullNumber.format(repo.stargazers_count || 0)} stars`, srLabel: " stars",
      }),
      statItem("fork", compactNumber.format(repo.forks_count || 0), {
        title: `${fullNumber.format(repo.forks_count || 0)} forks`, srLabel: " forks",
      })
    );
    const updated = el("time", { text: `Updated ${timeAgo(repo.pushed_at || repo.updated_at)}` });
    const when = repo.pushed_at || repo.updated_at;
    if (when) {
      updated.setAttribute("datetime", when);
      updated.title = new Date(when).toLocaleString();
    }
    const updatedWrap = el("span", { className: "stat" }, [icon("clock"), updated]);
    stats.append(updatedWrap);

    const children = [head, desc];
    if (tags.length) children.push(el("ul", { className: "topics", attrs: { "aria-label": "Topics" } }, tags));
    children.push(el("div", { className: "card__foot" }, [bar, stats]));
    card.append(...children);
    return card;
  }

  function visibleItems() {
    if (state.sort !== "name") return state.items;
    return [...state.items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  function renderResults() {
    const items = visibleItems();
    const maxStars = Math.max(1, ...items.map((r) => r.stargazers_count || 0));
    resultsEl.replaceChildren(...items.map((repo) => renderCard(repo, maxStars)));
    resultsEl.setAttribute("aria-busy", "false");
  }

  function renderStatus() {
    const shown = state.items.length;
    const scope = state.lang ? ` in ${state.lang}` : "";
    let text = `Showing ${fullNumber.format(shown)} of ${fullNumber.format(state.total)} repositories for “${state.query}”${scope}.`;
    if (state.total > MAX_VISIBLE_RESULTS) text += ` GitHub lets you page through the first ${fullNumber.format(MAX_VISIBLE_RESULTS)}.`;
    if (state.sort === "name") text += " Sorted A to Z across the results loaded so far.";
    if (state.incomplete) text += " GitHub timed out partway, so some matches may be missing.";
    setStatus(text);
  }

  function updateLoadMore() {
    const limit = Math.min(state.total, MAX_VISIBLE_RESULTS);
    const canLoadMore = state.items.length > 0 && state.items.length < limit;
    moreBtn.hidden = !canLoadMore;
    moreBtn.removeAttribute("aria-disabled");
    moreBtn.textContent = "Load more";
  }

  function showRate(rate) {
    if (rate.remaining !== null && rate.limit !== null) {
      rateEl.textContent = `Search requests left this minute: ${rate.remaining} of ${rate.limit}.`;
    }
  }

  // ------------------------------------------------------------------ search
  async function runSearch({ reset }) {
    if (state.loading && !reset) return;
    if (inflight) inflight.abort();
    const controller = new AbortController();
    inflight = controller;
    const myRequest = ++requestCounter;
    lastAction = () => runSearch({ reset });

    const nextPage = reset ? 1 : state.page + 1;
    state.loading = true;
    clearError();
    emptyEl.hidden = true;
    suggestionsEl.hidden = true;
    state.hasSearched = true;

    if (reset) {
      state.items = [];
      state.total = 0;
      moreBtn.hidden = true;
      setStatus("Searching GitHub…");
      renderSkeletons();
    } else {
      moreBtn.setAttribute("aria-disabled", "true");
      moreBtn.textContent = "Loading…";
    }

    try {
      const data = await fetchRepos({
        query: state.query, lang: state.lang, sort: state.sort, page: nextPage, signal: controller.signal,
      });
      if (myRequest !== requestCounter) return; // a newer search replaced this one

      const previousCount = state.items.length;
      const seen = new Set(state.items.map((r) => r.id));
      state.items = state.items.concat(data.items.filter((r) => !seen.has(r.id)));
      state.total = data.total;
      state.incomplete = data.incomplete;
      state.page = nextPage;
      showRate(data.rate);

      if (state.items.length === 0) {
        resultsEl.replaceChildren();
        resultsEl.setAttribute("aria-busy", "false");
        const scope = state.lang ? ` written in ${state.lang}` : "";
        emptyEl.querySelector("p").textContent =
          `Nothing matched “${state.query}”${scope}. Try fewer or broader keywords${state.lang ? ", or set the language to Any" : ""}.`;
        emptyEl.hidden = false;
        setStatus("0 repositories found.");
        moreBtn.hidden = true;
        return;
      }

      renderResults();
      renderStatus();
      updateLoadMore();

      if (!reset && state.sort !== "name") {
        const links = resultsEl.querySelectorAll(".card__title a");
        if (links[previousCount]) links[previousCount].focus();
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      if (myRequest !== requestCounter) return;
      if (reset) {
        resultsEl.replaceChildren();
        resultsEl.setAttribute("aria-busy", "false");
        setStatus("");
      } else {
        updateLoadMore();
      }
      showError(err instanceof ApiError ? err.message : "Something went wrong. Try again.", { retry: true });
    } finally {
      if (myRequest === requestCounter) state.loading = false;
    }
  }

  function startSearch({ push }) {
    const query = qInput.value.trim();
    if (!query) {
      clearError();
      showError("Enter a keyword to search, for example “python” or “machine learning”.");
      qInput.setAttribute("aria-invalid", "true");
      qInput.focus();
      return;
    }
    state.query = query;
    state.lang = langSelect.value;
    state.sort = sortSelect.value;
    writeUrlState(push);
    runSearch({ reset: true });
  }

  // --------------------------------------------------------------- URL state
  function readUrlState() {
    const p = new URLSearchParams(window.location.search);
    const langs = Array.from(langSelect.options).map((o) => o.value || o.text);
    const lang = p.get("lang") || "";
    const sort = p.get("sort") || "best";
    return {
      query: (p.get("q") || "").slice(0, 256).trim(),
      lang: lang === "" || langs.includes(lang) ? lang : "",
      sort: SORTS.includes(sort) ? sort : "best",
    };
  }

  function writeUrlState(push) {
    const p = new URLSearchParams();
    if (state.query) p.set("q", state.query);
    if (state.lang) p.set("lang", state.lang);
    if (state.sort !== "best") p.set("sort", state.sort);
    const qs = p.toString();
    try {
      window.history[push ? "pushState" : "replaceState"](null, "", qs ? `?${qs}` : window.location.pathname);
    } catch (e) { /* some browsers block history changes on file:// pages */ }
  }

  function restoreFromUrl() {
    const url = readUrlState();
    qInput.value = url.query;
    langSelect.value = url.lang;
    sortSelect.value = url.sort;
    if (url.query) {
      state.query = url.query;
      state.lang = url.lang;
      state.sort = url.sort;
      runSearch({ reset: true });
    } else {
      if (inflight) inflight.abort();
      requestCounter++;
      Object.assign(state, { query: "", items: [], total: 0, page: 0, hasSearched: false, loading: false });
      resultsEl.replaceChildren();
      moreBtn.hidden = true;
      emptyEl.hidden = true;
      clearError();
      setStatus("");
      suggestionsEl.hidden = false;
    }
  }

  // ------------------------------------------------------------------ wiring
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    startSearch({ push: true });
  });

  qInput.addEventListener("input", () => {
    if (qInput.getAttribute("aria-invalid") === "true") clearError();
  });

  // Language and sort are applied by GitHub, so changing them re-runs the search.
  [langSelect, sortSelect].forEach((select) =>
    select.addEventListener("change", () => {
      if (qInput.value.trim()) startSearch({ push: true });
    })
  );

  moreBtn.addEventListener("click", () => runSearch({ reset: false }));
  window.addEventListener("popstate", restoreFromUrl);
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next, true);
  });

  applyTheme(document.documentElement.getAttribute("data-theme") || "light", false);
  renderSuggestions();
  restoreFromUrl();
})();
