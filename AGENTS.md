# AGENTS.md

Chrome extension (Manifest V3) that makes the guide availability grid on
`hsh.gomus.de/guide/availables` usable: one click marks a whole 90-minute tour
block instead of 18 five-minute cells. `README.md` describes it for the user;
this file is for working on it.

## Layout

- `extension/manifest.json` – MV3, content script on `https://hsh.gomus.de/guide/*`, `storage` permission only.
- `extension/content/content.js` – everything that runs on the page: grid model, block view, writes, panel UI.
- `extension/popup/` – settings (block length, preset times, working-hours window).
- `tools/dev-inject.js` – loads the content script into an already-open page (see Verification).
- `tools/make_icons.py` – regenerates `extension/icons/*.png`.

No build step, no dependencies, no test runner. Plain JS, loaded unpacked.

## Verification

There is no automated test suite. Verify against the real page, in this order:

1. `chrome://extensions` → reload the extension (content scripts are cached until then). The
   reload button can be clicked from Playwright with
   `page.locator('#dev-reload-button').first().evaluate((el) => el.click())` – a normal
   `click()` fails the visibility check on `chrome://` pages.
2. Open `https://hsh.gomus.de/guide/availables?start_at=<next monday>` and exercise the change.
3. Assert on `td.timestampbutton` classes (`not_set`, `available_no_bookings`,
   `not_available_no_bookings`, `available_with_bookings`, `not_available_with_bookings`), and on
   the cell markup – a cell must contain an `<i>` and its `textContent` must be empty. Visible
   `<` or `\` in a cell means the response parsing broke again.
4. Reload the page and re-check: the server is the source of truth, the DOM is not.
5. Undo/restore everything you changed. This is live availability data for a real guide, on days
   that may already have bookings.

Faster iteration without reloading the extension: run `tools/dev-inject.js` through the Playwright
MCP tool `browser_run_code_unsafe`. It stubs `chrome.storage`, then injects the CSS and script.
Note it cannot run twice in one page (top-level `const` redeclaration), so reload first.

Loading the unpacked extension into a Playwright-launched Chrome does not work – Chrome refuses
`--load-extension` under automation. Test the popup by serving `extension/popup/` over HTTP with a
stubbed `chrome.storage`.

## How the site works (learned the hard way)

- The grid is `table.available-table`, 288 rows × 7 day columns. Each cell is
  `td.timestampbutton.available-table-cell` with `data-timestamp` (unix seconds) and `id="avail_<ts>"`.
  Row order is chronological; column order follows the `thead` day headers.
- Clicking a cell toggles `not_set → available → not_available → not_set` (three states, not two).
  Booked cells carry their own `*_with_bookings` states.
- One POST per cell to `/guide/availables/toggle_available_date` with `form_update_td_id=<ts>` and
  the CSRF token from `meta[name=csrf-token]`. The response is JavaScript containing
  `$('#avail_<ts>').replaceWith('...')`; the payload is a **single-quoted JS string with escaped
  quotes and `\/`**, so unescape it properly before parsing (`unescapeJsString`) – handling only
  `\'` leaves `<\/i>` in the DOM and renders markup as text.
- The extension mutates the existing `<td>` in place (`className` + `innerHTML`) instead of
  replacing it, because the site binds its click handler directly to each cell element.
- The site's own bulk endpoint (`/guide/availables/generate_available_dates.23`) answers `422` even
  from its own modal, so it is unusable. Do not build on it.
- Write in parallel but modestly (8 concurrent); ~26 ms per request, so 126 cells ≈ 2–3 s.
- Cells without the `clickable` class are in the past and silently ignore writes – filter them and
  report the count instead of pretending the block was applied.
- Day headers: the `thead th` also contains a hidden dropdown ("Kernzeit auf verfügbar setzen"), so
  `th.innerText` returns that menu too. Read `th.querySelector('small')` instead.

## Views

The default view replaces the site's table with `#tah-block-view`: one row per preset start time,
one cell per day, each cell aggregating the 18 underlying five-minute cells (`summarize()` returns
`available` / `unavailable` / `not_set` / `mixed` / `past`). Clicking a cell toggles the whole block
between available and not set. The day headers carry a ✓/✗ pair (`dayHeadNode`) that sets the whole
day – restricted to the working-hours range (`dayCells`) – and clears it again when the matching
button is already active. The original table stays in the DOM (just `display: none`), so the
grid model, writes, undo and Shift/Alt selection all keep working unchanged – any write must call
`refreshBlockView()` afterwards, and `applyView()` is the single place that swaps the two tables.

## Data gotchas

- `bue shift schedule.ics` stores **UTC** (`DTSTART:20261003T105500Z`), while the site and grid show
  local time (that booking is "12:55 Uhr"). Convert with `Europe/Berlin` before deriving any time
  from it. All times in the extension are local wall-clock time.
- The museum's tours are fixed in UTC, so their local start times shift by an hour at DST.
  Presets are static local times; that is a known limitation, not a bug.
- The availability rules on the page are also authoritative: toggling a cell inside a rule's window
  makes the server snap it back. Do not assume a write "sticks" without reloading.

## Conventions

- UI strings are German (the site is German), code and comments are English.
- Match the site's look: Bootstrap 3-ish, `#1e4b8c` accent, 12 px panel text.
- Keep the extension dependency-free; no frameworks, no bundler.
- Never break the site's native behaviour: a plain click must stay a single-slot toggle, and the
  extension must not swallow clicks it does not handle.
