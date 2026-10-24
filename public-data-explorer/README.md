# Repository Explorer

A responsive web app for exploring public GitHub repositories. Search by keyword, narrow by language, sort by stars, recent activity, or name, and page through results. All data is fetched live from the GitHub REST API.

**Live demo:** _add your GitHub Pages link here_

![Search results](docs/screenshot-results.png)
_Replace with your own screenshots (see the checklist at the bottom)._

## Features

- **Live data:** nothing is hardcoded. Every result comes from the GitHub Search API.
- **Search:** keyword search across repository names, descriptions, and topics.
- **Filter:** language filter (applied by GitHub, so results are accurate across the whole result set).
- **Sort:** best match, most stars, recently updated (all server-side), and name A to Z (applied to the results loaded so far, because the API cannot sort by name).
- **Load more:** pages through results 30 at a time, up to the 1,000 that GitHub exposes per search.
- **Clear states:** loading skeletons, empty-result message, and specific errors for rate limiting, network failure, and invalid searches, each with a "Try again" action where useful.
- **Shareable searches:** the query, language, and sort are stored in the URL (`?q=python&lang=Python&sort=stars`), so the back button and bookmarks work.
- **Light and dark themes:** follows the system setting, with a manual toggle that is remembered.
- **Accessible:** keyboard navigable, visible focus, skip link, screen-reader status updates, reduced-motion support.
- **Reading the cards:** each card has a spine in the repository's main language colour and a small bar comparing its stars with the other loaded results (log scale).

## API used

[GitHub REST API: Search repositories](https://docs.github.com/en/rest/search/search#search-repositories)

`GET https://api.github.com/search/repositories?q=<keywords> language:<lang>&sort=<stars|updated>&order=desc&per_page=30&page=<n>`

It returns name, owner, description, primary language, star and fork counts, topics, last push date, archived status, and the repository URL. No API key is needed.

## Run locally

The site must be served over HTTP (opening the file directly can break URL handling).

```bash
cd public-data-explorer
python3 -m http.server 8000
```

Then open http://localhost:8000. Alternatively, use the VS Code "Live Server" extension.

## Project structure

```
public-data-explorer/
├── index.html      page structure, controls, status areas
├── css/style.css   design tokens, layout, themes, responsive rules
├── js/app.js       API calls, rendering, search/filter/sort, error handling
└── README.md
```

## Design and engineering decisions

- **Server-side filtering and sorting.** Sorting only the 30 loaded results would misrepresent the data, so language, stars, and recency are sent to GitHub. Name sorting is the one client-side exception and is labelled as such in the interface.
- **Safe rendering.** API text is written with `textContent`, never `innerHTML`. External links open with `target="_blank"` and `rel="noopener noreferrer"`.
- **Race-condition handling.** Starting a new search cancels the in-flight request (`AbortController`), and late responses from older searches are ignored.
- **Rate limits.** Unauthenticated search is limited to 10 requests per minute. The app reads GitHub's rate-limit headers, shows the remaining requests in the footer, and tells the user how long to wait when the limit is hit.
- **No tokens in the front end.** A personal access token placed in client-side JavaScript would be public, so the app deliberately uses the unauthenticated API. A production version would route requests through a small backend that holds the token.
- **No dependencies or build step.** Plain HTML, CSS, and JavaScript.

## Testing

Manual test cases. Tick each one after running it yourself, and note anything unexpected.

- [ ] Search a common keyword (`python`)
- [ ] Search a specific topic (`machine learning`)
- [ ] Change the language filter (including `C++` and `Jupyter Notebook`)
- [ ] Try each sort option (best match, most stars, recently updated, name A to Z)
- [ ] Click "Load more" until the button disappears
- [ ] Search for something with no results (for example `zzzzqqqxx`)
- [ ] Submit an empty search
- [ ] Trigger the rate limit (run more than 10 searches in a minute) and check the message
- [ ] Go offline (browser dev tools, Network, Offline) and search
- [ ] Resize to mobile width (about 375px) and check the layout
- [ ] Click a repository card and confirm it opens the right page in a new tab
- [ ] Use the browser back button after several searches
- [ ] Toggle the light and dark themes
- [ ] Navigate the whole page using only the keyboard

## Known limitations

- GitHub exposes at most the first 1,000 results of any search.
- Unauthenticated searches are limited to 10 per minute, so heavy use will hit the limit.
- Sorting by name only reorders the results already loaded.
- Language filtering uses each repository's primary language as detected by GitHub.
- Google Fonts are loaded from the web. If they are unavailable, the page falls back to system fonts.
