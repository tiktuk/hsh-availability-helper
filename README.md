# Tour Availability Helper

Chrome extension for the guide availability grid on `hsh.gomus.de/guide/availables`.
Instead of ticking 18 five-minute cells for every tour, you mark a whole
90-minute tour block with one click.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder in this repo
4. Open (or reload) <https://hsh.gomus.de/guide/availables>

The extension only runs on `hsh.gomus.de/guide/*`, needs no account of its own
and talks to the site with your existing login session.

## What it does

By default the grid is replaced by a **block view**: one row per tour
(`09:55–11:25`, `10:55–12:25`, …) instead of 288 five-minute rows. A cell shows
the state of the whole block for that day — green check = every slot available,
empty = nothing set, hatched with `6/18` = partially available, bookmark = a
booking sits in the block, grey = in the past.

Clicking a block cell marks the whole block available, clicking again clears
it. Each day column also has a **✓ / ✗** pair in the header that marks that
whole day available or unavailable (over the working-hours range, 09:55–18:30
by default); pressing the highlighted button again clears the day.
**Ansicht → 5 Min** switches back to the site's original grid at any time.

Above the grid sits a **Tour-Blöcke** panel:

- **Block ab …** – one button per usual tour start time. One click marks the
  whole block (90 min by default) as *verfügbar* on every selected day.
  Defaults are the local start times from `bue shift schedule.ics`: 09:55,
  10:55, 11:55, 12:55, 13:55, 14:55 and 16:35 (the last tour of the day).
- **von / Dauer** – any start time (5-minute steps) and any length, for the
  group tours that start at `:15` or `:35`.
- **Mo … So** – pick which days the block applies to (all on by default).
- **verfügbar / nicht verfügbar / zurücksetzen** – sets the block to a target
  state instead of blindly toggling. Slots already in that state are left
  alone, so clicking twice is harmless.
- **Alt+Klick** on a cell – mark the 90-minute block starting at that cell as
  verfügbar.
- **Shift+Klick** on a cell – mark everything from the last plain-clicked cell
  to this one (a rectangle across days and rows).
- **Rückgängig** – the last operation can be undone for 20 seconds.
- **Ansicht** – switch between the block view and the site's 5-minute grid.
- **nur 09:55–18:30** – hides the morning and evening rows that are never
  booked. On by default; the range is editable in the settings. Hidden rows
  can still be written to, they are just not shown.

Plain clicks behave exactly like before: a single 5-minute cell toggles
through `nicht gesetzt → verfügbar → nicht verfügbar`.

The toolbar icon opens the settings: block length, the list of quick start
times, whether Alt+Klick is active, and the visible working-hours range.

## How it works

The page is a Rails app that posts one request per cell to
`/guide/availables/toggle_available_date` and swaps the cell HTML from the
returned JavaScript. The extension does the same request with the page's CSRF
token, up to 8 in parallel, then copies the returned cell markup into the
existing `<td>` (in place, so the site's own click handler keeps working).

A 90-minute block on all seven days is 126 cells and takes roughly 2–3 seconds.

Note: the site's own bulk endpoint
(`/guide/availables/generate_available_dates.23`, used by its drag-select
modal) currently answers `422` even when submitted from its own form, so this
extension deliberately does not use it.

Careful with times in `bue shift schedule.ics`: the file stores **UTC**
(`DTSTART:20261003T105500Z`), while the site and the availability grid show
local time (that booking is displayed as "12:55 Uhr"). All times in the
extension are local wall-clock time, matching the grid.

## Development

`tools/dev-inject.js` loads the content script into the already-open page
(through Playwright's `run_code_unsafe`), which is handy for iterating without
reloading the unpacked extension:

```
browser_run_code_unsafe({ filename: "tools/dev-inject.js" })
```

`tools/make_icons.py` regenerates the PNG icons.
