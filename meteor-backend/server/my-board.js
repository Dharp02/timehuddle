/**
 * "My Board" — a personal priority list of tickets/issues (Milestone 2.2).
 *
 * Identity only: `{ userId, sourceId, ticketId, addedAt }`. No title, status, or
 * any other display field is snapshotted here — the client resolves those by
 * looking the ref up against its already-fetched unified ticket list (Core
 * Model Data Discipline). A Redmine entry keeps its issue in that list — the
 * relevant list counts the board as a reason (`board`) — so an entry only goes
 * unresolved when its ticket is gone: a Huddle ticket deleted, or a Redmine
 * issue deleted or no longer visible. The Tickets page offers to remove those.
 */
import { Meteor } from 'meteor/meteor';

import { Mongo } from 'meteor/mongo';

import { MyBoard, Teams, Tickets, isValidId } from './collections';
import { requireIdentity } from './auth-bridge';
import { bustUserCaches } from './redmine-cache';

const DUPLICATE_KEY_ERROR_CODE = 11000;

// Enforces "one board row per (user, ticket)" at the storage layer, so
// `addMany` can upsert idempotently instead of erroring on a re-add.
Meteor.startup(async () => {
  try {
    await MyBoard.createIndexAsync(
      { userId: 1, sourceId: 1, ticketId: 1 },
      { unique: true, name: 'unique_my_board_entry' },
    );
  } catch (error) {
    console.error('[my-board] failed to create unique entry index:', error);
  }
});

function validateRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Meteor.Error('bad-request', 'refs array required');
  }
  for (const ref of refs) {
    if (typeof ref?.sourceId !== 'string' || !ref.sourceId || typeof ref?.ticketId !== 'string' || !ref.ticketId) {
      throw new Meteor.Error('bad-request', 'Each ref requires a sourceId and a ticketId.');
    }
  }
}

/** Upsert one (userId, sourceId, ticketId) entry, tolerating a concurrent-insert race. */
async function upsertEntry(userId, { sourceId, ticketId }) {
  const selector = { userId, sourceId, ticketId };
  try {
    await MyBoard.upsertAsync(selector, { $setOnInsert: { addedAt: new Date() } });
  } catch (err) {
    if (err?.code !== DUPLICATE_KEY_ERROR_CODE) throw err;
    // Lost a concurrent first-insert race against the unique index; the row
    // now exists, so there's nothing left to do.
  }
}

/**
 * Of these Huddle ticket ids, the ones this user can no longer see: deleted, or
 * in a team they are not in. The same visibility `tickets.byTeam` publishes, so
 * the Tickets page is told for certain — its live list can be momentarily
 * partial while the subscription fills, which must not read as "gone".
 */
async function unavailableHuddleTicketIds(userId, ticketIds) {
  if (!ticketIds.length) return new Set();
  const tickets = await Tickets.find(
    {
      _id: { $in: ticketIds.filter(isValidId).map((id) => new Mongo.ObjectID(id)) },
      status: { $ne: 'deleted' },
    },
    { fields: { teamId: 1 } },
  ).fetchAsync();
  const teamIds = [...new Set(tickets.map((t) => t.teamId).filter(isValidId))];
  const memberTeams = await Teams.find(
    {
      _id: { $in: teamIds.map((id) => new Mongo.ObjectID(id)) },
      $or: [{ members: userId }, { admins: userId }],
    },
    { fields: { _id: 1 } },
  ).fetchAsync();
  const visibleTeams = new Set(memberTeams.map((t) => t._id.toHexString()));
  const visible = new Set(
    tickets.filter((t) => visibleTeams.has(t.teamId)).map((t) => t._id.toHexString()),
  );
  return new Set(ticketIds.filter((id) => !visible.has(id)));
}

/**
 * The board is a reason for a Redmine issue to be in the relevant list, which is
 * cached for 90 seconds, so a board change must clear it.
 */
function bustIfRedmine(userId, refs) {
  if (refs.some((ref) => ref.sourceId === 'redmine')) bustUserCaches(userId);
}

/** Delete these (sourceId, ticketId) entries from one user's board. */
export async function removeBoardEntries(userId, refs) {
  const result = await MyBoard.rawCollection().deleteMany({
    userId,
    $or: refs.map(({ sourceId, ticketId }) => ({ sourceId, ticketId })),
  });
  bustIfRedmine(userId, refs);
  return result.deletedCount;
}

Meteor.methods({
  /**
   * List the caller's My Board entries (identity only, no display fields).
   * A Huddle entry whose ticket the caller can no longer see is marked
   * `unavailable`; Redmine entries are answered by `redmine.issues.relevant`,
   * since only Redmine can say whether an issue still exists.
   */
  async 'myBoard.list'() {
    const { userId } = await requireIdentity(this);
    const entries = await MyBoard.find(
      { userId },
      { fields: { sourceId: 1, ticketId: 1, addedAt: 1 } },
    ).fetchAsync();
    const gone = await unavailableHuddleTicketIds(
      userId,
      entries.filter((e) => e.sourceId === 'huddle').map((e) => e.ticketId),
    );
    return {
      entries: entries.map((e) => ({
        sourceId: e.sourceId,
        ticketId: e.ticketId,
        addedAt: e.addedAt,
        ...(e.sourceId === 'huddle' && gone.has(e.ticketId) ? { unavailable: true } : {}),
      })),
    };
  },

  /** Add tickets to the caller's My Board. Idempotent — re-adding is a no-op. */
  async 'myBoard.addMany'({ refs } = {}) {
    const { userId } = await requireIdentity(this);
    validateRefs(refs);
    await Promise.all(refs.map((ref) => upsertEntry(userId, ref)));
    bustIfRedmine(userId, refs);
    return { addedCount: refs.length };
  },

  /** Remove tickets from the caller's My Board. */
  async 'myBoard.removeMany'({ refs } = {}) {
    const { userId } = await requireIdentity(this);
    validateRefs(refs);
    return { removedCount: await removeBoardEntries(userId, refs) };
  },
});
