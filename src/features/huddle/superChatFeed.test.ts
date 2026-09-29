import { describe, expect, it } from 'vitest';
import type { HuddlePost } from '@lib/api';
import { canPostIn, postsToConversations } from './superChatFeed';

/** Build an epoch ms from local calendar components, so fixtures and their
 *  expected "HH:MM" / weekday output stay identical regardless of the test
 *  runner's timezone (both are read back via local Date getters). */
function localMs(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

const SEP_29_0858 = localMs(2026, 9, 29, 8, 58);
const SEP_29_1032 = localMs(2026, 9, 29, 10, 32);
const SEP_28_0900 = localMs(2026, 9, 28, 9, 0);
const NOW = localMs(2026, 9, 29, 12, 0);

function makePost(overrides: Partial<HuddlePost> & { id: string }): HuddlePost {
  const createdAt = overrides.createdAt ?? new Date(SEP_29_0858).toISOString();
  return {
    teamId: 'team-1',
    userId: 'user-aisha',
    userName: 'Aisha Khan',
    userInitials: 'AK',
    content: { text: 'Checklist UI is done.', mentions: [] },
    attachments: [],
    likes: [],
    commentCount: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

const VIEWER_MEMBER = { userId: 'user-aisha', isAdmin: false };
const VIEWER_OTHER_MEMBER = { userId: 'user-priya', isAdmin: false };
const VIEWER_ADMIN = { userId: 'user-priya', isAdmin: true };

describe('postsToConversations', () => {
  describe('grouping', () => {
    it('groups by session via clockEventId', () => {
      const posts = [
        makePost({
          id: 'p1',
          clockEventId: 'evt-1',
          session: { startTime: SEP_29_0858, endTime: SEP_29_1032 },
        }),
        makePost({
          id: 'p2',
          userId: 'user-priya',
          userName: 'Priya Sharma',
          clockEventId: 'evt-2',
          session: { startTime: SEP_28_0900, endTime: null },
        }),
      ];
      const conversations = postsToConversations(posts, 'session', VIEWER_MEMBER, NOW);
      expect(conversations).toHaveLength(2);
      const ids = conversations.map((c) => c.id).sort();
      expect(ids).toEqual(['session:evt-1', 'session:evt-2']);
    });

    it('groups by day using postDate, falling back to the created date', () => {
      const posts = [
        makePost({ id: 'p1', postDate: '2026-09-29' }),
        makePost({
          id: 'p2',
          userId: 'user-priya',
          createdAt: new Date(SEP_29_1032).toISOString(),
        }),
        makePost({ id: 'p3', postDate: '2026-09-28' }),
      ];
      const conversations = postsToConversations(posts, 'day', VIEWER_MEMBER, NOW);
      const byId = new Map(conversations.map((c) => [c.id, c]));
      expect(byId.get('day:2026-09-29')?.thread.filter((m) => m.type !== 'system')).toHaveLength(2);
      expect(byId.get('day:2026-09-28')?.thread).toHaveLength(1);
    });

    it('groups by person via userId', () => {
      const posts = [
        makePost({ id: 'p1', userId: 'user-aisha' }),
        makePost({ id: 'p2', userId: 'user-aisha' }),
        makePost({ id: 'p3', userId: 'user-priya' }),
      ];
      const conversations = postsToConversations(posts, 'person', VIEWER_MEMBER, NOW);
      const ids = conversations.map((c) => c.id).sort();
      expect(ids).toEqual(['person:user-aisha', 'person:user-priya']);
    });

    it('groups by ticket, bucketing posts with no ticket under "none"', () => {
      const posts = [
        makePost({ id: 'p1', ticketId: 'tkt-1', ticketTitle: 'Onboarding checklist' }),
        makePost({ id: 'p2', ticketId: 'tkt-1', ticketTitle: 'Onboarding checklist' }),
        makePost({ id: 'p3' }),
      ];
      const conversations = postsToConversations(posts, 'ticket', VIEWER_MEMBER, NOW);
      const byId = new Map(conversations.map((c) => [c.id, c]));
      expect(byId.get('ticket:tkt-1')?.thread).toHaveLength(2);
      expect(byId.get('ticket:none')?.thread).toHaveLength(1);
      expect(byId.get('ticket:none')?.title).toBe('No ticket');
    });
  });

  describe('live sessions', () => {
    it('marks a live session (no endTime) as "● Live" with no clock-out message', () => {
      const posts = [
        makePost({
          id: 'p1',
          clockEventId: 'evt-1',
          session: { startTime: SEP_29_0858, endTime: null },
        }),
      ];
      const [conversation] = postsToConversations(posts, 'session', VIEWER_MEMBER, NOW);
      expect(conversation.title).toContain('● Live');
      const systemMessages = conversation.thread.filter((m) => m.type === 'system');
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0].text).toContain('Clocked in');
    });

    it('adds both clock-in and clock-out messages for a finished session', () => {
      const posts = [
        makePost({
          id: 'p1',
          clockEventId: 'evt-1',
          session: { startTime: SEP_29_0858, endTime: SEP_29_1032 },
        }),
      ];
      const [conversation] = postsToConversations(posts, 'session', VIEWER_MEMBER, NOW);
      expect(conversation.title).not.toContain('Live');
      const systemMessages = conversation.thread.filter((m) => m.type === 'system');
      expect(systemMessages).toHaveLength(2);
      expect(systemMessages[0].text).toContain('Clocked in');
      expect(systemMessages[1].text).toContain('Clocked out');
    });
  });

  describe('titles', () => {
    it('shows hours (and no-wrap-up warning) for admins, not for members', () => {
      const posts = [
        makePost({
          id: 'p1',
          clockEventId: 'evt-1',
          session: { startTime: SEP_29_0858, endTime: SEP_29_1032 },
        }),
      ];
      const [adminView] = postsToConversations(posts, 'session', VIEWER_ADMIN, NOW);
      const [memberView] = postsToConversations(posts, 'session', VIEWER_MEMBER, NOW);
      expect(adminView.title).toContain('1h 34m');
      expect(adminView.title).toContain('⚠ no wrap-up');
      expect(memberView.title).not.toContain('1h 34m');
      expect(memberView.title).not.toContain('no wrap-up');
    });

    it('omits the no-wrap-up warning once a post in the session has a wrap-up', () => {
      const posts = [
        makePost({
          id: 'p1',
          clockEventId: 'evt-1',
          session: { startTime: SEP_29_0858, endTime: SEP_29_1032 },
          wrapUpAt: new Date(SEP_29_1032).toISOString(),
        }),
      ];
      const [adminView] = postsToConversations(posts, 'session', VIEWER_ADMIN, NOW);
      expect(adminView.title).not.toContain('no wrap-up');
    });

    it('shows "You" for the viewer\'s own session thread', () => {
      const posts = [
        makePost({
          id: 'p1',
          userId: 'user-aisha',
          clockEventId: 'evt-1',
          session: { startTime: SEP_29_0858, endTime: SEP_29_1032 },
        }),
      ];
      const [asAuthor] = postsToConversations(posts, 'session', VIEWER_MEMBER, NOW);
      const [asOther] = postsToConversations(posts, 'session', VIEWER_OTHER_MEMBER, NOW);
      expect(asAuthor.title.startsWith('You')).toBe(true);
      expect(asOther.title.startsWith('Aisha Khan')).toBe(true);
    });
  });

  describe('posts without a session or ticket', () => {
    it('handles session-grouped posts with no clockEventId (fallback bucket, no clock messages)', () => {
      const posts = [makePost({ id: 'p1', postDate: '2026-09-29' })];
      const [conversation] = postsToConversations(posts, 'session', VIEWER_MEMBER, NOW);
      expect(conversation.id).toBe('session:nosession:user-aisha:2026-09-29');
      expect(conversation.thread.filter((m) => m.type === 'system')).toHaveLength(0);
      expect(conversation.title).toBe('You · Tue, Sep 29');
    });
  });

  describe('ticket threads', () => {
    it('never include clock in/out messages, even when posts carry session data', () => {
      const posts = [
        makePost({
          id: 'p1',
          ticketId: 'tkt-1',
          ticketTitle: 'Onboarding checklist',
          clockEventId: 'evt-1',
          session: { startTime: SEP_29_0858, endTime: SEP_29_1032 },
        }),
      ];
      const [conversation] = postsToConversations(posts, 'ticket', VIEWER_MEMBER, NOW);
      expect(conversation.thread.some((m) => m.type === 'system')).toBe(false);
      expect(conversation.participants.some((p) => p.kind === 'system')).toBe(false);
    });
  });
});

describe('canPostIn', () => {
  it('is always writable for day and ticket threads', () => {
    const posts = [makePost({ id: 'p1', ticketId: 'tkt-1', ticketTitle: 'Onboarding checklist' })];
    const [dayThread] = postsToConversations(posts, 'day', VIEWER_OTHER_MEMBER, NOW);
    const [ticketThread] = postsToConversations(posts, 'ticket', VIEWER_OTHER_MEMBER, NOW);
    expect(canPostIn(dayThread, 'day', VIEWER_OTHER_MEMBER)).toBe(true);
    expect(canPostIn(ticketThread, 'ticket', VIEWER_OTHER_MEMBER)).toBe(true);
  });

  it('is writable only by the author for session and person threads', () => {
    const posts = [
      makePost({
        id: 'p1',
        userId: 'user-aisha',
        clockEventId: 'evt-1',
        session: { startTime: SEP_29_0858, endTime: SEP_29_1032 },
      }),
    ];
    const [sessionThread] = postsToConversations(posts, 'session', VIEWER_MEMBER, NOW);
    const [personThread] = postsToConversations(posts, 'person', VIEWER_MEMBER, NOW);
    expect(canPostIn(sessionThread, 'session', VIEWER_MEMBER)).toBe(true);
    expect(canPostIn(personThread, 'person', VIEWER_MEMBER)).toBe(true);
    expect(canPostIn(sessionThread, 'session', VIEWER_OTHER_MEMBER)).toBe(false);
    expect(canPostIn(personThread, 'person', VIEWER_OTHER_MEMBER)).toBe(false);
  });
});
