# HSH-Helper

Chrome extension for the guide side of `hsh.gomus.de`. On the availability grid
it replaces 18 five-minute cells per tour with one 90-minute block, so a whole
day is a handful of clicks instead of hundreds. On the calendar it turns the
month's shifts into a printable invoice, letterhead and all.

![The block view: one row per tour, one cell per day, with per-day check and cross buttons](docs/screenshot.png)

## Install

The extension is not in the Chrome Web Store, so you load it yourself. That
needs two things people usually miss: the code has to be **downloaded** first,
and Chrome's extension page is only reachable through the **browser menu** —
`chrome://extensions` is not a clickable link.

1. **Get the code.** Open
   <https://github.com/tiktuk/hsh-helper>, click the green
   **Code** button → **Download ZIP**, then unzip it somewhere you will keep it
   (e.g. `Documents`). With git installed, `git clone
   https://github.com/tiktuk/hsh-helper.git` does the same.
   Chrome loads the extension from that folder on every start, so don't delete
   it afterwards.
2. **Open the extensions page.** Click the **⋮** menu at the top right of
   Chrome → **Extensions** → **Manage extensions**. (Typing `chrome://extensions`
   into the address bar works as well, but the browser blocks that link when it
   comes from a web page.)
3. Turn on **Developer mode** (toggle at the top right of that page).
4. Click **Load unpacked** and select the `extension` folder *inside* the
   downloaded folder (`hsh-helper/extension`), not the folder you
   unzipped.
5. Open (or reload) <https://hsh.gomus.de/guide/availables>. The grid should now
   be the block view; the toolbar icon opens the settings.

To update an installed copy later, see [Update](#update).

The extension only runs on `hsh.gomus.de/guide/*`, needs no account of its own
and talks to the site with your existing login session.

## Update

Chrome does not update an unpacked extension by itself, so a new version only
arrives when you fetch it and reload the extension. How you fetch it depends on
how you installed it: **`git pull` only works if you cloned the repository.** If
you used **Download ZIP**, that folder is not a git repository and git will just
say `not a git repository`.

Either way, the last step is the same:

- Open `chrome://extensions` and click the **circular arrow** on the
  **HSH-Helper** card (or press the reload icon on the card).
- Then reload the `hsh.gomus.de` tab. A tab that was already open keeps running
  the old code until you do.

### If you cloned with git

One-time, if you have not cloned it yet:

```sh
cd ~/Documents                    # or wherever you want to keep the folder
git clone https://github.com/tiktuk/hsh-helper.git
```

Then load `hsh-helper/extension` in Chrome as described above. Later, to update:

1. Open a terminal **inside the `hsh-helper` folder**:
   - **macOS:** open Terminal, type `cd ` (with the space), drag the folder from
     Finder into the window, press Enter. Or right-click the folder in Finder →
     **Services** → **New Terminal at Folder**. The first time, macOS may offer
     to install the developer tools — accept, that is where `git` comes from.
   - **Windows:** open the folder in Explorer, click the address bar, type `cmd`,
     press Enter.
2. Run `git pull`. It lists the changed files, or says `Already up to date.`
   when there is nothing new.
3. Reload the extension as above.

Check that Chrome loads the `extension` folder *inside the cloned copy*:
**Details** on the card in `chrome://extensions` shows the folder it was loaded
from. If you installed from a ZIP earlier, remove that card and load the cloned
folder once; after that, `git pull` is all it takes to stay current.

### If you downloaded the ZIP

Open <https://github.com/tiktuk/hsh-helper>, click **Code** → **Download ZIP**,
unzip it and let it replace the old folder — or delete the old folder first and
unzip to the same place. Keep the path identical, since that is where Chrome
loads the extension from. Then reload the extension as above.

Your settings — letterhead, bank details, signature, invoice numbers — live in
Chrome's extension storage, not in that folder, so updating either way keeps
them.

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
  Defaults are the local start times of the actual tours: 09:55,
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
times, whether Alt+Klick is active and the visible working-hours range. From
there, **Rechnung einrichten …** opens the invoice settings.

## Monatsrechnung

On `/guide/calendar` the month header has a **Rechnung** button. Pick a month
(prefilled with the month on screen) and the panel shows a live preview — number
of tours, sum, and the invoice number that month would get. **Rechnung
erstellen** then opens a printable invoice in a new tab. **Drucken / als PDF
speichern** opens the browser's print dialog.

The invoice is a letter plus a services table: sender and recipient blocks,
`Rechnung <Nummer>`, "Honorar für <Monat>", Steuernummer, greeting, intro, the
two assurance clauses, bank details, closing line and your signature image, then
one row per booking (Buchung, Datum, von, bis, Angebotstitel, Kunde, Honorar)
with the sum on its own page.

Everything in that letter comes from **Rechnung einrichten** (popup → the
button): name and address, recipient, Steuernummer, bank details, all texts, and
the signature image. Empty fields simply do not appear, so a letter without a
Steuernummer or bank details still prints. The fields carry example text as
placeholders — nothing is prefilled with real data, except the recipient, which
defaults to the museum. The signature is shrunk to 800 px wide and kept in local
storage only, so it is not synced between machines.

A month without bookings says so in the panel and keeps the button disabled —
there is nothing to bill yet.

Past shifts are included even when the guide never confirmed them — they are
still valid work. The same goes for **cancellations by the group**: they are
billed at the Ausfallhonorar the booking carries (49 €). Cancellations by the
guide, and bookings the guide was moved off, have no amount on their Abrechnung;
they are left off the invoice and the panel says how many. If a booking has no
customer (public tours), the Gruppenbezeichnung from the booking comment is used,
and failing that the tour title.

Invoice numbers continue from **Rechnungsnummer ab** in the invoice settings,
with an optional prefix (e.g. `RE-2026-`). Each month keeps the number it was
first given, so opening a month again does not burn a number, and the number can
be edited directly on the invoice.

## Tastenkürzel

On every guide page, hold **Alt**:

| Keys | Action |
| --- | --- |
| `Alt+1` … `Alt+6` | jump to the sidebar entries in their order: Dashboard, Buchungsliste, Kalender, Verfügbarkeiten, Termingruppen, Helpdesk |
| `Alt+R` | show the invoice preview for the month on screen — press it again to create the invoice |
| `Alt+P` / `Alt+N` | previous / next month on the calendar page |

The sidebar entries show their key in the tooltip. `Alt+R` does nothing on
pages without an invoice panel, so it never swallows the key there.

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

Careful with the site's calendar export: it stores **UTC**
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

## Licence

MIT — see [LICENSE](LICENSE). The extension is written for the guide
availability page of one specific booking system; nothing here is affiliated
with or endorsed by that provider.

