/**
 * superChatFeed — map huddle posts onto the SuperChat conversation model.
 *
 * One participant per post author, one message per post (newest-first is
 * handled by SuperChat's order="desc"). Image attachments are embedded as
 * markdown images (rendered by createImagePlugin with a lightbox); other
 * attachments become plain links. Comments deliberately stay in the classic
 * card view — SuperChat has no per-message thread concept.
 *
 * `postsToConversations` (the SuperChatInbox replacement, see
 * docs/huddle-superchat-inbox-plan.md) groups posts into many conversations
 * instead of one; `postsToConversation` above stays until Milestone 8.
 */
import { resolveMediaUrl } from '@lib/api';
import type { HuddlePost } from '@lib/api';
import { avatarColorToCss, getUserColor } from './avatar';
import { formatDuration } from '@lib/timeUtils';
import type {
  Participant,
  SuperChatConversation,
  SuperChatMessage,
} from '@mieweb/ui/components/SuperChat';

function attachmentMarkdown(att: HuddlePost['attachments'][number]): string {
  const name = att.filename ?? 'attachment';
  // Posts store attachment URLs by path — bind them to the current backend
  // origin, same as the card view does (see PostCard).
  const url = resolveMediaUrl(att.url);
  if (att.type === 'image') return `![${name}](${url})`;
  return `[📎 ${name}](${url})`;
}

/** Message text = post markdown + ticket tag + attachment embeds/links. */
export function postToMessageText(post: HuddlePost): string {
  const parts = [post.content.text];
  if (post.ticketTitle) {
    parts.push(`\`🎫 ${post.ticketTitle}\``);
  }
  if (post.attachments.length > 0) {
    parts.push(post.attachments.map(attachmentMarkdown).join('\n\n'));
  }
  return parts.filter(Boolean).join('\n\n');
}

export function postsToConversation(
  teamId: string,
  teamName: string,
  posts: HuddlePost[],
): SuperChatConversation {
  const participants = new Map<string, Participant>();
  for (const post of posts) {
    if (!participants.has(post.userId)) {
      participants.set(post.userId, {
        id: post.userId,
        kind: 'human',
        name: post.userName || post.userInitials || 'Unknown',
      });
    }
  }

  const thread: SuperChatMessage[] = posts.map((post) => ({
    id: post.id,
    participantId: post.userId,
    text: postToMessageText(post),
    time: post.createdAt,
    editedAt: post.updatedAt !== post.createdAt ? post.updatedAt : undefined,
  }));

  return {
    id: teamId,
    title: teamName,
    participants: [...participants.values()],
    thread,
  };
}

// ─── SuperChatInbox grouping (postsToConversations) ────────────────────────

export type ThreadBy = 'session' | 'day' | 'person' | 'ticket';

export interface InboxViewer {
  userId: string;
  isAdmin: boolean;
}

const SYSTEM_PARTICIPANT_ID = 'system';

/** "YYYY-MM-DD" for the given epoch ms, based on the local calendar date. */
function localDateKey(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** A post's plan/wrap-up calendar date, falling back to its created date. */
function getPostDateKey(post: HuddlePost): string {
  return post.postDate ?? localDateKey(new Date(post.createdAt).getTime());
}

/** "08:58" — local wall-clock time, matching the rest of the app's clock UI. */
function formatClockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Tue, Sep 29" for a "YYYY-MM-DD" key, parsed as a local calendar date. */
function formatDayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function groupKeyFor(post: HuddlePost, threadBy: ThreadBy): string {
  switch (threadBy) {
    case 'session':
      return post.clockEventId ?? `nosession:${post.userId}:${getPostDateKey(post)}`;
    case 'day':
      return getPostDateKey(post);
    case 'person':
      return post.userId;
    case 'ticket':
      return post.ticketId ?? 'none';
  }
}

interface SessionInfo {
  clockEventId: string;
  startTime: number;
  endTime: number | null;
}

/** Every distinct clock session referenced by a group's posts, oldest first. */
function collectSessions(posts: HuddlePost[]): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const post of posts) {
    if (post.clockEventId && post.session && !byId.has(post.clockEventId)) {
      byId.set(post.clockEventId, {
        clockEventId: post.clockEventId,
        startTime: post.session.startTime,
        endTime: post.session.endTime,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.startTime - b.startTime);
}

function systemMessagesForSession(session: SessionInfo): SuperChatMessage[] {
  const messages: SuperChatMessage[] = [
    {
      id: `${session.clockEventId}:clock-in`,
      type: 'system',
      participantId: SYSTEM_PARTICIPANT_ID,
      text: `Clocked in at ${formatClockTime(session.startTime)}`,
      time: new Date(session.startTime),
    },
  ];
  if (session.endTime != null) {
    messages.push({
      id: `${session.clockEventId}:clock-out`,
      type: 'system',
      participantId: SYSTEM_PARTICIPANT_ID,
      text: `Clocked out at ${formatClockTime(session.endTime)}`,
      time: new Date(session.endTime),
    });
  }
  return messages;
}

/** Plan/wrap-up + ticket label for a post, e.g. "Plan · 🎫 Onboarding checklist". */
function postLabelParts(post: HuddlePost): string[] {
  const parts: string[] = [];
  if (post.clockEventId) {
    parts.push(post.wrapUpAt ? 'Wrap-up' : 'Plan');
  }
  if (post.ticketTitle) {
    parts.push(`🎫 ${post.ticketTitle}`);
  }
  return parts;
}

/** Message text for the inbox: body first (the sidebar preview shows the
 *  first line), then attachments, then an italic plan/ticket label. */
function postToInboxMessageText(post: HuddlePost): string {
  const parts = [post.content.text];
  if (post.attachments.length > 0) {
    parts.push(post.attachments.map(attachmentMarkdown).join('\n\n'));
  }
  const label = postLabelParts(post);
  if (label.length > 0) {
    parts.push(`*${label.join(' · ')}*`);
  }
  return parts.filter(Boolean).join('\n\n');
}

function displayName(post: HuddlePost, viewer: InboxViewer): string {
  return post.userId === viewer.userId ? 'You' : post.userName || post.userInitials || 'Unknown';
}

function buildTitle(
  threadBy: ThreadBy,
  posts: HuddlePost[],
  sessions: SessionInfo[],
  viewer: InboxViewer,
  now: number,
): string {
  const first = posts[0];
  switch (threadBy) {
    case 'day':
      return formatDayLabel(getPostDateKey(first));
    case 'person':
      return displayName(first, viewer);
    case 'ticket':
      return first.ticketId ? (first.ticketTitle ?? 'Ticket') : 'No ticket';
    case 'session': {
      const dateLabel = formatDayLabel(getPostDateKey(first));
      const name = displayName(first, viewer);
      const session = sessions[0];
      if (!session) return `${name} · ${dateLabel}`;

      const isLive = session.endTime == null;
      const span = `${formatClockTime(session.startTime)}\u2013${isLive ? 'now' : formatClockTime(session.endTime as number)}`;
      let title = `${name} · ${dateLabel} · ${span}`;
      if (isLive) title += ' · \u25CF Live';
      if (viewer.isAdmin) {
        const endTime = session.endTime ?? now;
        title += ` · ${formatDuration((endTime - session.startTime) / 1000)}`;
        if (!isLive && !posts.some((p) => p.wrapUpAt)) {
          title += ' · \u26A0 no wrap-up';
        }
      }
      return title;
    }
  }
}

/**
 * Group huddle posts (+ their clock sessions) into SuperChatInbox
 * conversations. Pure: no React, no API calls, no `Date.now()` — pass `now`
 * explicitly so callers (and tests) get a stable "live" duration/label.
 */
export function postsToConversations(
  posts: HuddlePost[],
  threadBy: ThreadBy,
  viewer: InboxViewer,
  now: number = Date.now(),
): SuperChatConversation[] {
  const groups = new Map<string, HuddlePost[]>();
  for (const post of posts) {
    const key = groupKeyFor(post, threadBy);
    const bucket = groups.get(key);
    if (bucket) bucket.push(post);
    else groups.set(key, [post]);
  }

  const conversations: SuperChatConversation[] = [];
  for (const [key, groupPosts] of groups) {
    const sessions = threadBy === 'ticket' ? [] : collectSessions(groupPosts);

    const participants = new Map<string, Participant>();
    for (const post of groupPosts) {
      if (!participants.has(post.userId)) {
        participants.set(post.userId, {
          id: post.userId,
          kind: 'human',
          name: post.userName || post.userInitials || 'Unknown',
          color: avatarColorToCss(getUserColor(post.userId)),
        });
      }
    }

    const systemMessages = sessions.flatMap(systemMessagesForSession);
    if (systemMessages.length > 0) {
      participants.set(SYSTEM_PARTICIPANT_ID, {
        id: SYSTEM_PARTICIPANT_ID,
        kind: 'system',
        name: 'Clock',
      });
    }

    const postMessages: SuperChatMessage[] = groupPosts.map((post) => ({
      id: post.id,
      participantId: post.userId,
      text: postToInboxMessageText(post),
      time: post.createdAt,
      editedAt: post.updatedAt !== post.createdAt ? post.updatedAt : undefined,
    }));

    const thread = [...systemMessages, ...postMessages].sort(
      (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
    );

    const isLive = sessions.some((s) => s.endTime == null);
    const lastActivity = isLive
      ? new Date(now)
      : new Date(Math.max(...thread.map((m) => new Date(m.time).getTime())));

    conversations.push({
      id: `${threadBy}:${key}`,
      title: buildTitle(threadBy, groupPosts, sessions, viewer, now),
      participants: [...participants.values()],
      thread,
      lastActivity,
    });
  }

  return conversations;
}

/** The raw group key encoded after the `${threadBy}:` prefix in a conversation
 *  id built by {@link postsToConversations} (e.g. a clockEventId, a ticketId,
 *  a "YYYY-MM-DD" day, or the `nosession:<userId>:<day>` fallback key). */
export function conversationGroupKey(conversationId: string): string {
  return conversationId.slice(conversationId.indexOf(':') + 1);
}

/**
 * Whether the viewer can post into a conversation, given how the inbox is
 * currently grouped:
 * - Day and ticket threads are writable by everyone (sending creates the
 *   viewer's own post).
 * - Session and person threads are single-author by construction — writable
 *   only by that author.
 */
export function canPostIn(
  conversation: SuperChatConversation,
  threadBy: ThreadBy,
  viewer: InboxViewer,
): boolean {
  if (threadBy === 'day' || threadBy === 'ticket') return true;
  const humanParticipantIds = conversation.participants
    .filter((p) => p.kind === 'human')
    .map((p) => p.id);
  return humanParticipantIds.length > 0 && humanParticipantIds.every((id) => id === viewer.userId);
}
