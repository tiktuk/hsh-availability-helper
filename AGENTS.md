# AGENTS.md

Chrome extension (Manifest V3) that makes the guide availability grid on
`hsh.gomus.de/guide/availables` usable: one click marks a whole 90-minute tour
block instead of 18 five-minute cells. `README.md` describes it for the user;
this file is for working on it.

## Layout

- `extension/manifest.json` – MV3, content script on `https://hsh.gomus.de/guide/*`, `storage` permission only.
- `extension/content/content.js` – everything that runs on the page: grid model, block view, writes, panel UI, month invoice.
- `extension/popup/` – settings (block length, preset times, working-hours window, invoice numbering).
- `extension/background.js` – service worker; its only job is opening the invoice tab (`chrome.tabs.create`).
- `extension/invoice/` – the printable invoice page (`chrome-extension://` URL, data handed over via `chrome.storage.local`).
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

`tools/dev-inject.js` also stubs `chrome.storage.local` and `chrome.runtime.sendMessage`, capturing
writes on `window.__tahLocal` / `window.__tahSync`, so the whole invoice flow can be exercised on
the live calendar page without installing anything (it only issues GETs).

Loading the unpacked extension into a Playwright-launched Chrome does not work – Chrome refuses
`--load-extension` under automation. Test the popup and `invoice/invoice.html` by serving the repo
root over HTTP with a stubbed `chrome.storage` (`addInitScript`). For print layout use
`browser_emulate_media { media: "print" }`.

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

## Invoices

The calendar page (`/guide/calendar?start_at=YYYY-MM-01`) gets a **Rechnung**
button in the month header; the panel is prefilled from the `legend` ("November
2026"), not from the URL, because the header is re-rendered by the site's own
month links. Month navigation is a full page load, so re-mounting is enough.

Data comes from the bookings list, not the calendar grid:

- `GET /guide/bookings?start_at=<month>-01&end_at=<next month>-01&per_page=200&status[]=20&guide_status_types[]=11,15,20,500`
  – `status[]=20` is Gebucht, the guide statuses include Unbestätigt, because
  past shifts count even when the guide never confirmed them. 200 covers a
  month (the site defaults to 25 per page).
- Each `tr.booking-list-item` carries `id="booking<id>"`; the date group sits in
  the preceding `tr.sticky-top` ("1. November 2026"), the time and the duration
  (105 minutes) in the "Datum: … Uhr / Dauer: …" cell.
- The price is **not** in the list. It is the `td.price` of the "Abrechnung" box
  on `/guide/bookings/<id>` (Honorar, e.g. `97,50 €`), one detail request per
  booking. The customer is the `dd` of the "Kundendaten" box; it is empty for
  public tours, so fall back to the `Gruppenbezeichnung` in `.booking-comment`
  (that block also holds other lines) and then to the tour title.
- The panel previews the month (count, sum, number) as soon as it opens and
  whenever the month changes: `previewInvoice()` loads the rows and shows
  `peekInvoiceNumber()`, which must not claim a number. Only **Rechnung
  erstellen** calls `assignInvoiceNumber()` and writes the number map; it reuses
  the rows the preview already loaded, so the invoice matches what was on screen.
- Numbers live in `chrome.storage.sync.invoiceNumbers` (`{ '2026-11': 'RE-2026-100' }`),
  assigned from `invoiceStart` + `invoicePrefix` and reused for the same month.
  Only trailing digits count when finding the highest number, since prefixes
  contain digits too.
- The payload is written to `chrome.storage.local.invoice`; `background.js`
  opens `invoice/invoice.html`, which only reads it. It cannot be opened from
  the page directly (`chrome-extension://` URLs are blocked for web content).
  The worker opens it with `sender.tab.windowId` and `active: true`; without
  that Chrome picks the focused window and the tab shows up somewhere else.
  A failed `tabs.create` is reported back and surfaced, never swallowed.
- A month without bookings keeps **Rechnung erstellen** disabled and says so in
  the panel, instead of failing after the click. The button is also disabled
  while a preview loads, so a click cannot race the preview.

## Data gotchas

- The site's calendar export stores **UTC** (`DTSTART:20261003T105500Z`), while the site and grid
  show local time (that booking is "12:55 Uhr"). Convert with `Europe/Berlin` before deriving any
  time from it. All times in the extension are local wall-clock time. The export itself is personal
  data and is gitignored, not part of this repo.
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
