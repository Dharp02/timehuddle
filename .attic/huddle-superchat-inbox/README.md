# Archived Huddle Card View

**Archived on**: 2026-09-29

**Reason**: Replaced by `SuperChatInbox` (see
[`docs/huddle-superchat-inbox-plan.md`](../../docs/huddle-superchat-inbox-plan.md), issue #601).
`src/pages/Huddle.tsx` no longer has a cards/chat toggle — the inbox is the only feed view.

## What Was Here

- `PostCard/` — the card-per-post feed item: markdown body, attachments, ticket tag, like button,
  edit/delete menu, and the comments panel underneath.
- `HuddleComments/` — the flat comment list + add-comment box shown under an expanded `PostCard`.

## Why They're Archived, Not Deleted

`SuperChatInbox` has no per-message reply/thread concept, so comments have no equivalent surface in
the new inbox (see the **Out of Scope** section of the execution plan). Comments are **not shown
anywhere in the app right now**, but:

- Comment data (`huddleComments` collection) is untouched.
- The backend methods (`huddle.getComments`, `huddle.addComment`, `huddle.deleteComment`, …) are
  untouched.
- Likes (`post.likes`) are similarly still stored; see Milestone 9 of the execution plan for what
  happened to the like button.

If replies land in `SuperChatInbox` upstream, comments can come back by building a new surface
against the existing data/methods — these files are kept as a reference for the previous UI and
interaction patterns (optimistic add/delete, permission checks), not to be revived as-is.

## Migration Notes

`Huddle.tsx`'s inbox now renders every published post as a top-level message via
`postsToConversations` (`src/features/huddle/superChatFeed.ts`), grouped by session/day/person/
ticket instead of one card per post.
