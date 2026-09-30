# Redmine MVP2 — Part B: Search Dropdown & UX

Sep 25, 2026 · @Shubhdeep Sarkar

## Overview

Part B adds Google-style suggestions to the existing Tickets page search bar. The same input keeps its current job, filtering the table, and gains a suggestion dropdown underneath it. There is no separate button or control. Part B owns everything under `src/` and `tests/e2e/`.

**What the user sees**

1. **The table fills itself.** The user's relevant Redmine issues (assigned, recently logged, recent activity, watched, pinned, timer running) appear in the Tickets table automatically, alongside Huddle tickets. Nothing has to be added by hand.
2. **They click into the empty search bar.** A dropdown opens under it with their top 8 suggested issues, each with a reason chip such as _Assigned_ or _Logged 2d ago_.
3. **They type.** The table filters as it does today, and the dropdown narrows to the matching suggestions. After a short pause, a **More from Redmine** section adds matching issues that are not in the table. `#1234`, a pasted Redmine link and `@name` work too.
4. **They pick a row.** Enter or a click opens the issue. The timer icon on a row starts a timer on it.
5. **The x hides a suggestion**, and an _Undo_ toast appears. The issue stays in the table.

**Dependency on Part A.** All data comes from the four methods in the API contract section of Redmine MVP2 — Part A: Backend & Security. **Part A has landed** (PR #570), so no stub is needed: `redmineApi.issues.relevant`, `redmineApi.issues.search`, `redmineApi.prefs.set` and `redmineApi.prefs.listDismissed` are typed and callable in `src/lib/api.ts`, and the e2e fixtures in `tests/e2e/fixtures/redmine.ts` already answer all four.

**Part A's cleanup came with it.** Removing `redmine.issues.list` meant the Tickets table could not be left pointing at it, so the four checkboxes below about `src/lib/api.ts`, `redmineSource` and the scope control are already ticked — see Task A5. What remains for Part B is the dropdown itself, dismiss/undo/restore, the states, the text and the e2e tests. **Built on branch `redmine-mvp2-part-b`.** Implementation notes are in `src/features/tickets/redmine/README.md`.

## Prerequisites (backend fixes before Part B starts)

Found reviewing Part A (PR #570) and fixed on the same branch, except the two items that cannot be done from this repo. The first two blocked Part B: without them the dismiss button and the refetch-after-dismiss flow break in normal use.

**Blocking**

- [x] **Hiding a group-assigned issue undoes itself on the next list load.** `isAssignedToCaller` in `meteor-backend/server/redmine-suggestions.js` compares `issue.assigned_to.id` with the user's own Redmine id. Redmine's `assigned_to_id=me`, which the "assigned" signal uses, also returns issues assigned to the user's groups. So a dismissed group-assigned issue is stored with `assignedToMeAtDismissal: false`, `partitionIssuePrefs` treats it as a reassignment, and the dismissal is deleted. The x appears not to work.
  - Fix: decide "assigned to me" the same way the signal does, with `issueQuery(account, { issue_id: id, assigned_to_id: 'me', status_id: '*' })`. It passes the filter guard and includes group assignments.
  - Test: dismissing a group-assigned issue survives the next `redmine.issues.relevant` call.
  - **Done:** `isIssueAssignedToMe` in `redmine-client.js`, used by `isAssignedToCaller`. Tested in `tests/redmine-hardening.test.ts`.
- [x] **The relevant-list rate limit counts cached responses too.** `enforceLimit(relevantLimiter, …)` runs before `relevantCache.get`, and the Tickets table and the dropdown share the 10-per-minute budget. Task B4 clears the client cache and refetches after every pin, dismiss, undo and timer start, so a page load plus a few dismissals returns `too-many-requests` during ordinary use.
  - Fix: count only cache misses, the calls that actually reach Redmine. Cache hits cost nothing and should not be limited.
  - Test: 20 calls inside the 90-second cache window all succeed. Repeated cache misses are still refused after 10.
  - **Done:** the limit is checked inside the cache's fetch. Tested in `tests/rate-limit.test.ts`.

**Should fix in the same follow-up**

- [x] **The 8-second budget can be exceeded.** Signals are each bounded at 6 s, but resolving the bare ids (`listIssuesByIds` in `buildRelevantIssues`, `redmine-relevance.js`) runs after them with its own 6 s bound, so the worst case is about 12 s. Give the method one overall deadline and pass the time remaining to the resolve step. **Done:** `RELEVANT_BUDGET_MS` (7.5 s) covers signals and resolve together, and the resolve is skipped (list marked `partial`) when under 1 s is left. Tested in `tests/redmine-relevance.test.ts`.
- [ ] **The activity signal covers the latest few events, not 14 days.** `from` has no effect on `/activity.atom`. Redmine's Atom feed appears to return only the newest `feeds_limit` entries (15 by default), which matches the 13 seen in testing. Confirm this on the enterprise instance and record it in the Part A doc. No code change is needed if it's confirmed. **Still open:** needs a session against the enterprise instance.
- [x] **`project_id` alone counts as a filter.** `ISSUE_FILTERS` in `redmine-client.js` accepts `project_id` on its own, and one project can hold thousands of issues. No current caller does this, but the guard should require `project_id` to come with another filter. **Done:** `project_id` removed from `ISSUE_FILTERS`, and the guard is exported as `isNarrowIssueQuery` so it has tests.
- [x] **Starting a timer on an already-pinned issue does not clear the relevant cache.** `pinIssueIfUnset` returns early without calling `bustUserCaches`, so the "Timer running" reason can appear up to 90 seconds late. Clear the cache on every Redmine timer start. **Done** in `pinIssueIfUnset`. Not covered by a test: the prefs store is Mongo-backed and has no unit tests.
- [ ] **Throttled calls return HTTP 500.** The error code is correct (`too-many-requests`), but the status should be 429 so clients and monitoring can tell throttling from a server fault. Until this changes, Part B must check the error code, never the status. **Not fixable here:** the meteor-wormhole REST bridge (`vendor/meteor-wormhole`, a separate repo) answers **every** `Meteor.Error` with 500, including `not-connected` and `bad-request`. Raise it as an issue on `mieweb/meteor-wormhole`.

## Task B1: The combobox and its states

**One input, two jobs.** The existing `@mieweb/ui` `Input` on the Tickets page keeps filtering the table on every keystroke, exactly as today. The suggestion dropdown is added to that same input. The dropdown shows Redmine issues only; Huddle tickets are found through the table filter, as now.

**Built with `downshift`'s `useCombobox`.** Decided after comparing the options:

| Option                                 | Why not / why                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@mieweb/ui` `Autocomplete` (0.9–0.10) | Rows are `<button>`s, so the timer and x cannot sit inside them. The highlighted row is internal, and `inputProps.onKeyDown` replaces its arrow-key handling, so Delete-to-hide cannot be added. No groups, no loading slot                |
| `cmdk` (used by `CommandPalette.tsx`)  | Built for an always-open list with its own input. Using it here means replacing our `Input` or hand-wiring the combobox ARIA, plus managing open/close and positioning ourselves                                                           |
| **`downshift` `useCombobox`** (chosen) | Headless and built for autocomplete dropdowns. `getInputProps()` spreads onto the existing `@mieweb/ui` `Input` (it forwards its ref and all input attributes), gives the combobox ARIA, and exposes `highlightedIndex` for Delete-to-hide |

- [x] Add `downshift` (9.x) as a dependency. It is headless: everything visible still comes from `@mieweb/ui` (`Input`, `Badge`, `Spinner`, `Text`, `Button`)
- [x] Build a `RedmineSuggestions` component in `src/features/tickets/redmine/` that owns the `useCombobox` state. `TicketsPage.tsx` passes the query in and gets table filtering back unchanged
- [x] Load the `mieweb-ui-design` skill before building, as the repo requires
- [ ] File an issue on `mieweb/ui` asking `Autocomplete` for groups, row actions, a controlled highlighted row and a loading slot. Keep `RedmineSuggestions`' props close to that shape, so moving to it later is cheap — **not filed yet**: it goes to another repo, so it waits for a go-ahead

**States**

| Input                                    | Dropdown shows                                                                                     | Data source                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Empty, on focus                          | **Suggested for you**: top 8 relevant issues, plus "Show all" to expand to the full list           | `redmine.issues.relevant()`, without dismissed issues |
| 1–2 characters                           | Suggested for you, filtered by title, `#id`, project or assignee                                   | Browser only                                          |
| 3+ characters, or `#`, a link or `@name` | The filtered suggestions, then **More from Redmine** with matching issues not already in the table | `redmine.issues.search`, after a 300 ms pause         |

- [x] On first focus, call `redmine.issues.relevant()` **without** `includeDismissed` and cache it for the session, keyed by user id. The table's call keeps `includeDismissed: true`. Two calls are needed because the table must show dismissed issues and the dropdown must not. The server caches both for 90 seconds, and after the rate-limit prerequisite cache hits cost nothing
- [x] More from Redmine leaves out any issue already shown in the table or in Suggested for you
- [x] Escape closes the dropdown but keeps the query, so the table stays filtered
- [x] Enter with no highlighted row does nothing extra: the table filter is already applied
- [x] Placeholder hint: _Search, #number, @person, or paste a link_
- [x] Empty results: word the message by the `kind` the server returned, e.g. "No issue #1234, or you can't see it" or "More than one person matches @al. Type more of the name". `@name` matches display names, not logins, so the message should suggest typing the person's name

## Task B2: Result rows

A row carries five things: `#id`, the title, a reason chip, the timer and the x. To keep it from getting cramped, **only the title and `#id` are always visible**. Everything else is placed by priority:

| Part        | When it shows                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `#id`       | Always, fixed width, muted                                                                                                                      |
| Title       | Always. Takes the remaining space and truncates with an ellipsis. The full title is in the row's `title` attribute                              |
| Project     | Under the title in small muted text, on screens `sm` and wider. Hidden on narrow screens                                                        |
| Reason chip | Always on wide screens. On narrow screens only on the highlighted row                                                                           |
| Timer and x | On the highlighted or hovered row only, taking the chip's place at the end. On touch devices, always visible and the chip moves under the title |

| Reason from the server | Chip text                                                               |
| ---------------------- | ----------------------------------------------------------------------- |
| `running`              | Timer running                                                           |
| `assigned`             | Assigned                                                                |
| `logged`               | Logged 2d ago (from `lastTimeLoggedAt`, formatted in the user's locale) |
| `activity`             | Recent activity                                                         |
| `watching`             | Watching                                                                |
| `pinned`               | Pinned                                                                  |

- [x] Show only the strongest reason as a chip. The server sends reasons in score order, so take the first
- [x] **Enter** or a click on the row opens the issue's detail page in TimeHuddle
- [x] **Timer:** starts a timer on the issue through the existing timer flow, `timersApi.createEntry({ ticketId, source: 'redmine', date, startNow: true })`, which also closes any running timer. Part A pins the issue on the server when a timer starts. Close the dropdown and show a toast, _Timer started on #1234_
- [x] The row whose timer is already running shows a stop icon in place of the timer icon
- [x] **Keyboard:** **Shift+Enter** starts the timer on the highlighted row
- [x] Rows under More from Redmine have no reason chip and no x (there is nothing to dismiss), but keep the timer
- [x] Render titles as plain text, never as HTML
- [x] Build one layout at dropdown widths of 320 px and 640 px, and check both before review
- [x] Switch `redmineSource` in `src/features/tickets/sources/redmineSource.ts` to `redmine.issues.relevant` with `includeDismissed: true`, so the Tickets table shows the relevant set and is not affected by dismissals — **done in Part A's Task A5**, which had to remove `redmine.issues.list` and could not leave the table pointing at it

## Task B3: Dismiss, undo and restore

The x hides an issue from **that user's search suggestions only**. It changes nothing in Redmine, in other users' views, in search results, or in the Tickets table. The server handles the 15-day expiry and the reassignment rule, so the client only calls `redmine.prefs.set`.

**Behaviour**

- [x] Clicking the x removes the row at once and calls `redmine.prefs.set({ issueId, state: 'dismissed' })`. Do not ask for confirmation
- [x] Show a toast: _Hidden #1234 · Undo_, for 6 seconds. Undo calls `redmine.prefs.set({ issueId, state: null })` and puts the row back where it was
- [x] If the call fails, put the row back and show an error toast
- [x] After dismissing, fill the empty slot from the rest of the cached relevant list, so the dropdown stays at 8 rows
- [x] Add **Hidden suggestions** to the Redmine card in Settings. It lists `redmine.prefs.listDismissed` with a Restore button on each row, and says that hidden issues come back on their own after 15 days

**Click handling**

- [x] Clicks on the timer and the x must not select the row or close the dropdown. Stop the event from reaching the row
- [x] Call `preventDefault()` on their `mousedown`, so the search input keeps focus

**Keyboard and screen readers**

In the accessible combobox pattern, rows cannot contain their own buttons. So the timer and the x are for the mouse, and the keyboard gets shortcuts.

- [x] The timer and the x have `tabIndex={-1}` and `aria-hidden="true"`
- [x] **Delete** or **Shift+Delete** on the highlighted row hides it, the same shortcut browsers use to remove autocomplete entries. Read the row from `useCombobox`'s `highlightedIndex`
- [x] **Shift+Enter** on the highlighted row starts its timer (Task B2)
- [x] Each row's `aria-describedby` mentions both shortcuts, e.g. "Press Delete to hide, Shift+Enter to start a timer"
- [x] Announce the toasts through an `aria-live="polite"` region
- [x] Up and Down move through rows, Enter opens, Escape closes. `useCombobox` provides these and `aria-activedescendant`; group headers are rendered outside the item list so they are never highlighted

## Task B4: Requests, loading states and caching

The dropdown should never show results for an older query, and should never go blank while waiting.

- [x] Wait 300 ms after the last keystroke before calling search. Issue numbers and pasted links search straight away
- [x] Tag each search with an increasing request number and ignore any response that is not for the latest one
- [x] While search runs, keep showing the local results with a small spinner in the More from Redmine header
- [x] `partial: true` on the relevant list: show the list plus a quiet note, "Some Redmine results are still unavailable"
- [x] Not connected: one row linking to Settings, "Connect Redmine to see your issues"
- [x] Redmine unreachable or timed out: keep the local results and show "Redmine didn't respond. Try again" with a retry
- [x] `too-many-requests`: show nothing extra. The next keystroke retries. Check the error code, not the HTTP status
- [x] Keep the relevant list in the existing module-level cache, keyed by user id. **Dismiss and undo update the cached list locally, without a refetch**, since they cannot change the table. Clear the cache and refetch on sign-out, restore and timer start
- [x] Keep search results in memory only, for the life of the dropdown. **Never write issues or search text to `localStorage`, `sessionStorage`, the URL or analytics.** A search term may be a patient's name

## Task B5: Cleanup, text, release note and e2e tests

**Remove the scope toggle**

- [x] Delete the `RedmineScope` type and `redmineApi.issues.list` in `src/lib/api.ts`, and add the four new methods — **done in Part A's Task A5.** All four are typed and callable; `RedmineRelevantIssue`, `RedmineSearchKind` and `RedmineIssuePrefState` are there to build the dropdown against
- [x] Remove the "mine / all" scope control from the Tickets page and `redmineScope` from the source context — **done in Part A's Task A5**, including the reload trigger in `useUnifiedTickets`
- [x] Ship this in the same PR as Part A's removal of `redmine.issues.list` — it did

**Text and translation**

- [x] Every new string goes through the app's translation setup: the placeholder, reason chips, section headers, toasts, empty and error messages, shortcut descriptions, and the Settings list
- [x] Format "Logged 2d ago" with `Intl.RelativeTimeFormat` in the user's locale
- [ ] Check the dropdown in a right-to-left language: the timer and the x swap sides, and truncation still keeps `#id` visible — **not checked**: the app has no RTL language to switch to yet, and the search icon's `left-3` / `pl-8` placement is physical, inherited from the input it replaced

**Release note**

- [x] Add to the existing `release-notes/1.0.3.md`, following the README. Explain that the Redmine list now shows _your_ issues, not everything, and how to find anything else with search, `#number` or `@person`

**E2E tests** (`tests/e2e/redmine/`)

- [x] The table shows the relevant issues without any user action
- [x] Focusing the empty search bar shows Suggested for you with reason chips, in score order
- [x] Typing filters the table and the suggestions, then More from Redmine appears with no issue that is already in the table
- [x] `#1234`, a pasted link and `@name` each find the right issue
- [x] The timer icon and Shift+Enter each start a timer on the right issue — the stop icon on a running row is not covered: the test backend has no Redmine, so the timer start is stubbed and never becomes a running timer
- [x] Dismiss removes the row, Undo brings it back, the issue stays in the table, and it still shows up in search
- [x] Delete on a highlighted row dismisses it. Keyboard-only navigation works end to end
- [x] Restore in Settings brings a hidden issue back
- [x] Not connected and partial states render — the unreachable/retry state has no e2e test yet
- [x] Rows are not cramped at 320 px wide: the title keeps most of the width and nothing overlaps
- [x] Update `me-assignee-filter.spec.ts` and `sources-unified.spec.ts`, which use the removed scope — **done in Part A's Task A5**; the fixture's disconnected defaults now cover `issues.search` and both prefs methods too, so a new spec that forgets to stub one gets a coherent disconnected app rather than a live call
- [x] `npm run test:all`, `npm run lint`, `npm run typecheck` and `npm run format` all pass — full run: 297 passed, 2 flaky (realtime ticket timers, team auto-accept; both passed on retry), and 5 email specs that failed only because the local test backend had no SMTP; all 5 pass with Mailpit configured. Checked in a browser against stubbed Redmine data, not a live Redmine

## Acceptance criteria

- [x] Relevant Redmine issues appear in the Tickets table automatically
- [x] Focusing the empty search bar shows up to 8 suggested issues without typing
- [x] Typing filters the table as before, and filters the suggestions with no network call
- [x] Server search results appear under More from Redmine, with no duplicates of the table and no results from an older query
- [x] A timer can be started from a suggestion with the mouse or Shift+Enter
- [x] The x and the Delete key both hide a suggestion, Undo restores it, and a hidden issue is still in the table and still found by search
- [x] Hidden issues can be restored from Settings
- [x] Dismissing has no effect on the Tickets table, timers or timesheets
- [x] The dropdown works with the keyboard alone and announces changes to screen readers
- [x] Rows stay readable at 320 px wide
- [x] No issue data or search text is stored in the browser or put in URLs
- [x] The scope toggle is gone, and a release note ships

## Decisions

- Opening a More from Redmine result does **not** pin it, for now. Starting a timer on it still does
- **Shift+Enter** is the timer shortcut. Nothing else in the app uses it

## Out of scope for MVP2

- Advanced search syntax such as combining `@name` with text, or filtering by project or status
- Pinning an issue by opening it from More from Redmine
- Huddle tickets in the suggestion dropdown (they are found through the table filter, as today)
- Offline search
- Dismissing Huddle tickets (Redmine suggestions only)
- Changing the Tickets table's layout beyond the new data source

## Changes after review (2026-09-26)

- **Timer control** is the shared green play / amber pause `TimerToggleButton` used on My Board rows, not a timer icon.
- **Starting a timer adds the issue to My Board**, from suggestions and from search results. The toast says which happened: _Timer started on #1234 and added to My Board_, _…It's on My Board_ when it was already there, or plain _Timer started on #1234_ if adding failed (the timer runs either way).
- **The "Timer running" chip follows the live timer.** The server's list is cached for 90 seconds, so the chip is corrected on the client from the page's running-timer state (`liveReasons` in `suggestions.ts`) and updates as soon as a timer starts or stops anywhere in the app.
- **Reason chips are neutral filled** (`secondary`), lifted a shade in dark mode so they don't disappear into the card.
- **Toasts** render through `src/ui/AppToasts.tsx`, mounted once in `AppLayout`: `@mieweb/ui`'s `Toast` inside our own container, with a neutral surface, a short fade-and-lift in and out, swipe left or right to dismiss on touch, and placement above the mobile tab bar. `@mieweb/ui`'s `ToastContainer` has no exit animation, no swipe and fixed accent colours, and the app-wide background-colour transition made its toasts flash in.
- **"Send to TimeHarbor"** was removed from the ticket row menu, with its now-unused client helpers. The backend methods and the "Shared with TimeHarbor" badge are unchanged.
