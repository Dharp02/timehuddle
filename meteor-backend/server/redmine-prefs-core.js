/**
 * The pin and dismissal rules, as one pure function (MVP2 A3).
 *
 * Six rules were agreed for dismissals, and all of them are read rules — they
 * decide what a stored row *means* now, not what to write. Keeping them in one
 * place, over plain rows and an explicit `now`, is what lets them be tested
 * without a database (see tests/redmine-prefs-core.test.ts); it is also why the
 * store does a single query and asks this function, rather than encoding each
 * rule again as a Mongo selector.
 *
 * | Rule | Where it lives |
 * | --- | --- |
 * | 1. Any suggestion may be dismissed, including one assigned to the user | `redmine.prefs.set` accepts any id |
 * | 2. A dismissal only hides that user's suggestions | only `redmine.issues.relevant` consults it |
 * | 3. It expires 15 days after `updatedAt` | `partitionIssuePrefs` (below) + the TTL index |
 * | 4. Dismissing again restarts the 15 days | `updatedAt` is rewritten on every set |
 * | 5. Reassignment to the user clears it | `partitionIssuePrefs` (below) |
 * | 6. A pin replaces a dismissal; `null` clears either | one row per (user, issue), unique index |
 *
 * Kept free of Meteor imports, like redmine-issues.js and redmine-activities.js.
 */

export const PINNED = 'pinned';
export const DISMISSED = 'dismissed';

/**
 * How long a dismissal lasts. Long enough that hiding a suggestion feels like it
 * stuck, short enough that a user cannot permanently blind themselves to an issue
 * they will be asked about — the suggestion list is a convenience, not a work
 * queue, and the issue is still findable by search the whole time.
 */
export const DISMISSAL_TTL_DAYS = 15;
export const DISMISSAL_TTL_MS = DISMISSAL_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Most dismissals any one user may hold. A bound, not a feature: without it a
 * script calling `redmine.prefs.set` in a loop grows the collection without
 * limit, and nobody has 500 issues they want hidden.
 *
 * Past the cap the **oldest dismissal is dropped**, which costs the user nothing:
 * a dismissal is a "not now" that expires by itself in 15 days anyway.
 */
export const MAX_DISMISSALS_PER_USER = 500;

/**
 * Most pins any one user may hold — the same bound, for a worse gap. Pins had no
 * cap at all: `surplusDismissalIds` counts `state: 'dismissed'` rows only, and
 * the TTL index sweeps the same, so nothing bounded a loop of pins. They neither
 * expire nor evict.
 *
 * Past this cap a new pin is **refused**, where a dismissal evicts. The two are
 * not symmetrical: a pin is what keeps an issue in the user's Tickets table and
 * on My Board, so silently unpinning their oldest to make room would take a row
 * away from them without saying so. Being told they are at the maximum is the
 * honest answer, and unpinning something is one click.
 *
 * These two are bounds on storage, not part of the numbered dismissal rules
 * above — a pin is not a dismissal, and the cap does not change what either
 * *means*.
 */
export const MAX_PINS_PER_USER = 500;

/**
 * Read one user's preference rows into the three answers callers need.
 *
 * - `pinnedIds` — worth 30 points to the relevant list, and never expire.
 * - `dismissedIds` — hide these from the suggestions, newest dismissal first.
 *   Rows past their 15 days are left out here as well as swept by the TTL index:
 *   Mongo's sweeper runs about once a minute, and "15 days" should not mean
 *   "15 days and a bit".
 * - `reviveIds` — dismissals the caller should now delete, because the issue has
 *   since been assigned to the user (rule 5). Being handed an issue is someone
 *   else's decision and it overrides a "not now" given before it happened. It
 *   does **not** override a deliberate dismissal of an issue that was already
 *   theirs, which is what `assignedToMeAtDismissal` records.
 *
 * A revived id is already absent from `dismissedIds`, so the list is correct on
 * the same call that notices the reassignment — the caller does not have to
 * re-read to get an accurate answer.
 *
 * @param {{issueId: number, state: string, updatedAt: Date, assignedToMeAtDismissal?: boolean}[]} rows
 * @param {{assignedIssueIds?: number[], now?: number}} [options]
 */
export function partitionIssuePrefs(rows, { assignedIssueIds = [], now = Date.now() } = {}) {
  const assigned = new Set(assignedIssueIds.map(Number));
  const cutoff = now - DISMISSAL_TTL_MS;

  const pinnedIds = [];
  const dismissals = [];
  const reviveIds = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const issueId = Number(row?.issueId);
    if (!Number.isSafeInteger(issueId) || issueId <= 0) continue;

    if (row.state === PINNED) {
      pinnedIds.push(issueId);
      continue;
    }
    if (row.state !== DISMISSED) continue;

    if (row.assignedToMeAtDismissal === false && assigned.has(issueId)) {
      reviveIds.push(issueId);
      continue;
    }
    const at = new Date(row.updatedAt ?? 0).getTime();
    // An unparseable date is treated as expired: a row we cannot age is a row we
    // cannot honour, and the safe direction is to show the issue again.
    if (!Number.isFinite(at) || at <= cutoff) continue;
    dismissals.push({ issueId, at });
  }

  return {
    pinnedIds,
    dismissedIds: dismissals.sort((a, b) => b.at - a.at).map((row) => row.issueId),
    reviveIds,
  };
}

/**
 * The rows of one state, newest first. An undated row sorts last, so a row that
 * cannot be aged is the first to be evicted rather than the last.
 */
function newestFirst(rows, state) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.state === state)
    .map((row) => ({ issueId: Number(row.issueId), at: new Date(row.updatedAt ?? 0).getTime() }))
    .sort((a, b) => b.at - a.at);
}

/**
 * The oldest dismissals to drop when a user is over the cap, newest kept.
 * Returns the ids to remove, so the store's delete is one statement.
 */
export function surplusDismissalIds(rows) {
  return newestFirst(rows, DISMISSED).slice(MAX_DISMISSALS_PER_USER).map((row) => row.issueId);
}

/**
 * Whether one more pin would put this user over `MAX_PINS_PER_USER`.
 *
 * `issueId` is the issue about to be pinned, and re-pinning something already
 * pinned is allowed at the cap: it writes no new row, and starting a timer pins,
 * so a user at their limit must still be able to time the issues they have
 * already pinned.
 *
 * Counts every `state: 'pinned'` row, whatever else is on it — which is what
 * keeps this correct for a pin that also carries a hide.
 */
export function pinWouldExceedCap(rows, issueId) {
  const pins = newestFirst(rows, PINNED);
  if (pins.some((pin) => pin.issueId === Number(issueId))) return false;
  return pins.length >= MAX_PINS_PER_USER;
}
