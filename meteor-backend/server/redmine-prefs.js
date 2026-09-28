/**
 * Storage for TimeHuddle's own opinions about Redmine issues (MVP2 A3).
 *
 * Redmine has no field for "keep this near the top of my list" or "stop
 * suggesting this to me", so those live here. Two states, one row each:
 *
 *   - **pinned** — the user, or starting a timer on their behalf, said this issue
 *     matters. Worth 30 points to the relevant list, and permanent until cleared.
 *   - **dismissed** — the user pressed the x on a suggestion. Hides the issue from
 *     *their own* search suggestions and nothing else: not from search results,
 *     not from the Tickets table, not from anyone else's view, and never from
 *     Redmine. It expires by itself after 15 days.
 *
 * Hiding a **pinned** issue does not turn its row into a dismissal: the row stays
 * pinned and gains `dismissedAt`. The pin is what keeps an issue someone else
 * owns in the Tickets table, so losing it would make hiding a suggestion drop a
 * table row. See rule 7 in redmine-prefs-core.js.
 *
 * **Ids only.** A row holds a user id, an issue id, a state, one boolean and a
 * date. No subject, no project, no description — resolving a dismissal's title
 * for the Settings list is a read-time `listIssuesByIds` call, so TimeHuddle
 * never becomes a second, staler, unaudited copy of the issue tracker.
 *
 * This module is the Mongo half. What the rows *mean* — the expiry, the
 * reassignment rule, the cap — is in redmine-prefs-core.js, which is why reads
 * here are a single query handed to one pure function instead of a selector per
 * rule.
 */
import { RedmineIssuePrefs } from './collections';
import { bustUserCaches } from './redmine-cache';
import {
  DISMISSAL_TTL_MS,
  DISMISSED,
  MAX_PINS_PER_USER,
  PINNED,
  partitionIssuePrefs,
  pinWouldExceedCap,
  surplusDismissalIds,
} from './redmine-prefs-core';

export { DISMISSED, PINNED } from './redmine-prefs-core';

/**
 * Create the indexes the rules depend on.
 *
 * The unique index is the invariant: one row per (user, issue), so pinning a
 * dismissed issue replaces the dismissal rather than racing it (rule 6). The TTL
 * index covers `state: 'dismissed'` only — pins are not a cache and must never be
 * swept — and `expireAfterSeconds` is measured from `updatedAt`, so dismissing
 * the same issue again restarts the clock for free (rule 4).
 */
export async function ensureRedmineIssuePrefIndexes() {
  await RedmineIssuePrefs.createIndexAsync(
    { userId: 1, issueId: 1 },
    { unique: true, name: 'unique_redmine_issue_pref' },
  );
  await RedmineIssuePrefs.createIndexAsync(
    { updatedAt: 1 },
    {
      name: 'expire_redmine_dismissals',
      expireAfterSeconds: DISMISSAL_TTL_MS / 1000,
      partialFilterExpression: { state: DISMISSED },
    },
  );
}

/** The fields that make a pinned row also hidden (rule 7). */
const HIDE_ON_PIN = { dismissedAt: '', assignedToMeAtDismissal: '' };

/**
 * Lift the hide on these issues: a dismissal row goes, a pinned row stays pinned.
 * Undo, Restore and the reassignment rule all mean "show it again", never "unpin".
 */
async function clearHides(userId, issueIds) {
  const issueId = { $in: issueIds };
  await RedmineIssuePrefs.updateAsync(
    { userId, issueId, state: PINNED },
    { $unset: HIDE_ON_PIN },
    { multi: true },
  );
  await RedmineIssuePrefs.removeAsync({ userId, issueId, state: DISMISSED });
}

/**
 * Thrown when a pin would pass `MAX_PINS_PER_USER`.
 *
 * A plain Error, not a `Meteor.Error`: this module is the Mongo half and stays
 * out of the method layer's vocabulary, so the method translates it into the
 * code the client branches on. `name` is what the method matches.
 */
export class TooManyPinsError extends Error {
  constructor() {
    super(`You can pin at most ${MAX_PINS_PER_USER} Redmine issues.`);
    this.name = 'TooManyPinsError';
  }
}

/**
 * Record, replace or clear one preference.
 *
 * `state: null` lifts a hide — Undo in the dropdown and Restore in Settings are
 * the same call — and leaves a pin in place. `assignedToMe` is stored for a
 * dismissal only, and only so the reassignment rule can tell "I hid an issue
 * that was already mine" from "I hid an issue that later became mine".
 */
export async function setIssuePref(userId, issueId, state, { assignedToMe = true } = {}) {
  if (state === null) {
    await clearHides(userId, [issueId]);
  } else if (state === PINNED) {
    // Refused rather than evicting the user's oldest pin, which would take a
    // Tickets row and a My Board entry away without saying so.
    if (pinWouldExceedCap(await allPrefRows(userId), issueId)) {
      throw new TooManyPinsError();
    }
    // A pin replaces a dismissal, and clears a hide on an existing pin (rule 6).
    await RedmineIssuePrefs.upsertAsync(
      { userId, issueId },
      { $set: { userId, issueId, state, updatedAt: new Date() }, $unset: HIDE_ON_PIN },
    );
  } else {
    const held = await RedmineIssuePrefs.findOneAsync({ userId, issueId }, { fields: { state: 1 } });
    const hide = { assignedToMeAtDismissal: assignedToMe === true };
    if (held?.state === PINNED) {
      // Rule 7: hide it, keep the pin.
      await RedmineIssuePrefs.updateAsync(
        { userId, issueId },
        { $set: { ...hide, dismissedAt: new Date() } },
      );
    } else {
      await RedmineIssuePrefs.upsertAsync(
        { userId, issueId },
        { $set: { userId, issueId, state, updatedAt: new Date(), ...hide } },
      );
      await trimDismissals(userId);
    }
  }
  // The relevant list is cached for 90 seconds and this changed what belongs in
  // it, so the next call must recompute rather than serve the pre-dismissal list.
  bustUserCaches(userId);
}

/**
 * Pin an issue, leaving an existing pin's date alone. Used by the timer-start
 * path, which fires on every start — rewriting `updatedAt` there would be pure
 * write noise, since a pin does not expire and its date carries no meaning.
 *
 * The cached relevant list is cleared either way: a timer just started, so the
 * issue's `running` signal changed even when its pin did not.
 */
export async function pinIssueIfUnset(userId, issueId) {
  const held = await RedmineIssuePrefs.findOneAsync(
    { userId, issueId },
    { fields: { state: 1, dismissedAt: 1 } },
  );
  // A hidden pin still needs the write: starting a timer lifts the hide (rule 6).
  if (held?.state === PINNED && held.dismissedAt == null) {
    bustUserCaches(userId);
    return;
  }
  await setIssuePref(userId, issueId, PINNED);
}

/** Keep only the newest `MAX_DISMISSALS_PER_USER` dismissals for one user. */
async function trimDismissals(userId) {
  const surplus = surplusDismissalIds(await allPrefRows(userId));
  if (surplus.length) {
    await RedmineIssuePrefs.removeAsync({ userId, issueId: { $in: surplus } });
  }
}

/** Every preference row for one user — ids, states and dates, bounded by the cap. */
function allPrefRows(userId) {
  return RedmineIssuePrefs.find(
    { userId },
    { fields: { issueId: 1, state: 1, updatedAt: 1, dismissedAt: 1, assignedToMeAtDismissal: 1 } },
  ).fetchAsync();
}

/**
 * This user's pins and live dismissals, with rule 5 applied.
 *
 * One query, one decision: dismissals of issues now assigned to the user are
 * deleted here and are already absent from `dismissedIds`, so the caller gets a
 * correct answer without a second read. `assignedIssueIds` comes from the
 * relevant list's own "assigned to me" signal, so the rule costs no extra
 * Redmine call.
 */
export async function readIssuePrefs(userId, { assignedIssueIds = [], now = Date.now() } = {}) {
  const partitioned = partitionIssuePrefs(await allPrefRows(userId), { assignedIssueIds, now });
  if (partitioned.reviveIds.length) {
    await clearHides(userId, partitioned.reviveIds);
  }
  return partitioned;
}

/** The ids this user has hidden, newest first — the Restore list in Settings. */
export async function dismissedIssueIds(userId, now = Date.now()) {
  return partitionIssuePrefs(await allPrefRows(userId), { now }).dismissedIds;
}

/** Forget every preference a user holds. Called when they unlink their Redmine account. */
export function removeUserIssuePrefs(userId) {
  return RedmineIssuePrefs.removeAsync({ userId });
}
