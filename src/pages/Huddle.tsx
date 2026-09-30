import {
  faBell,
  faCheck,
  faChevronDown,
  faMagnifyingGlass,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  Button,
  ButtonGroup,
  Dropdown,
  DropdownItem,
  EmptyState,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@mieweb/ui';
import { SuperChatInbox } from '@mieweb/ui/components/SuperChat';
import type { ComposerAttachment, SuperChatConversation } from '@mieweb/ui/components/SuperChat';
import {
  createCodePlugin,
  createImagePlugin,
  createMermaidPlugin,
} from '@mieweb/ui/components/SuperChat/plugins';
import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { HuddleComposer } from '../features/huddle/HuddleComposer';
import { fileFromDataUrl, toPostAttachment, uploadMedia } from '../features/huddle/api';
import { ComposerError } from '../features/huddle/ComposerError';
import { composerErrorMessage } from '../features/huddle/composerErrors';
import { getUserColor, getUserInitials } from '../features/huddle/avatar';
import {
  canPostIn,
  conversationGroupKey,
  postsToConversations,
  singleTeamOf,
  stripInboxDecorations,
  type ThreadBy,
} from '../features/huddle/superChatFeed';
import type { ComposerContent } from '../features/huddle/types';
import { AppPage } from '../ui/AppPage';
import { useRouter } from '../ui/router';
import { useSession } from '@lib/useSession';
import { useTeam } from '@lib/TeamContext';
import { huddleApi, type HuddlePost } from '@lib/api';
import { getDdpClient, useLiveClockEvents } from '@lib/ddp';
import { useRefresh } from '@lib/RefreshContext';
import { toDateString } from '@lib/timeUtils';

const THREAD_BY_KEY = 'app:huddleThreadBy';
// Team-tab value for the Personal view; team ids are never this string.
const PERSONAL_TAB = 'personal';
const THREAD_BY_OPTIONS: ThreadBy[] = ['session', 'day', 'person', 'ticket'];
const THREAD_BY_LABELS: Record<ThreadBy, string> = {
  session: 'Session',
  day: 'Day',
  person: 'Person',
  ticket: 'Ticket',
};

function loadStoredThreadBy(): ThreadBy {
  try {
    const stored = localStorage.getItem(THREAD_BY_KEY);
    return (THREAD_BY_OPTIONS as string[]).includes(stored ?? '')
      ? (stored as ThreadBy)
      : 'session';
  } catch {
    return 'session';
  }
}

export default function Huddle() {
  const { navigate, search, replace } = useRouter();
  const [posts, setPosts] = useState<HuddlePost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A failed inbox send or inline edit. Separate from `error` above, which is
  // a feed-load failure and takes the feed's place on screen.
  const [editError, setEditError] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [threadByMenuOpen, setThreadByMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // How the inbox groups posts into conversations. Persisted so a reload
  // keeps the reader's choice; switching it only re-runs the grouping
  // function below, it never refetches.
  const [threadBy, _setThreadBy] = useState<ThreadBy>(loadStoredThreadBy);
  const setThreadBy = useCallback((next: ThreadBy) => {
    _setThreadBy(next);
    try {
      localStorage.setItem(THREAD_BY_KEY, next);
    } catch {
      // Storage may be unavailable (private mode, embedded webview) — the
      // in-memory choice for this session still works.
    }
  }, []);
  const { user } = useSession();
  const {
    selectedTeamId,
    setSelectedTeamId,
    teams,
    allTeams,
    setSelectedOrgId,
    teamsReady,
    isAdmin,
    currentTime,
  } = useTeam();

  // Personal is a view, not a team selection: entering it leaves the selected
  // team and org alone, so the team tabs stay put. It shows the caller's own
  // posts across every team, fetched separately (no per-team DDP subscription
  // applies across teams). Having the Personal team itself selected (e.g. from
  // the header switcher) lands in the same view.
  const [showMe, setShowMe] = useState(false);
  const personalTeamId = allTeams.find((t) => t.isPersonal)?.id ?? null;
  const scope: 'team' | 'me' =
    showMe || (selectedTeamId !== null && selectedTeamId === personalTeamId) ? 'me' : 'team';
  // Where the first-post composer writes: the Personal team in the
  // Personal view, the selected team otherwise.
  const postingTeamId = scope === 'me' ? personalTeamId : selectedTeamId;

  // A team outside the selected org is filtered out of `teams` and would be
  // reset straight back by TeamContext, so switch the org along with it.
  // Only deep links need this; the team tabs are all in the selected org.
  const selectTeamAcrossOrgs = useCallback(
    (teamId: string) => {
      const crossOrg = teams.some((t) => t.id === teamId)
        ? undefined
        : allTeams.find((t) => t.id === teamId);
      if (crossOrg) setSelectedOrgId(crossOrg.orgId);
      setSelectedTeamId(teamId);
    },
    [teams, allTeams, setSelectedOrgId, setSelectedTeamId],
  );

  const teamTabs = teams.filter((t) => !t.isPersonal);
  const selectTab = (value: string) => {
    if (value === PERSONAL_TAB) {
      setShowMe(true);
      return;
    }
    setShowMe(false);
    setSelectedTeamId(value);
  };
  const [myPosts, setMyPosts] = useState<HuddlePost[]>([]);
  const [myPostsLoading, setMyPostsLoading] = useState(false);
  const [myPostsError, setMyPostsError] = useState<string | null>(null);
  const refreshMyPosts = useCallback(async () => {
    try {
      setMyPosts(await huddleApi.getMyPosts());
      setMyPostsError(null);
    } catch (err) {
      console.error('[Huddle] refreshMyPosts failed:', err);
      setMyPostsError('Failed to load your posts.');
    }
  }, []);
  useEffect(() => {
    if (scope !== 'me') return;
    setMyPostsLoading(true);
    refreshMyPosts().finally(() => setMyPostsLoading(false));
  }, [scope, refreshMyPosts]);

  // Deep-link support: /app/huddle?postId=XXX&teamId=YYY (e.g. from the
  // dashboard's Recent Activity feed, or a clock-in/out or huddle-comment
  // notification) — switch to the post's team, set Thread by to session, and
  // open the conversation containing it once loaded, then strip the query
  // params. Re-derived from `search` (not just mount) so tapping a second
  // notification while already on this page is honored.
  const [targetPostId, setTargetPostId] = useState<string | null>(() =>
    new URLSearchParams(search).get('postId'),
  );
  const [pendingTeamId, setPendingTeamId] = useState<string | null>(
    () => new URLSearchParams(search).get('teamId') ?? null,
  );
  useEffect(() => {
    const params = new URLSearchParams(search);
    const postId = params.get('postId');
    if (!postId) return;
    setTargetPostId(postId);
    setPendingTeamId(params.get('teamId'));
  }, [search]);

  // The feed only ever holds the selected team's posts, so a post from another
  // team can't resolve until the team is switched. Kept pending until the team
  // list has actually loaded.
  useEffect(() => {
    if (!pendingTeamId) return;
    if (pendingTeamId === selectedTeamId) {
      setShowMe(false);
      setPendingTeamId(null);
      return;
    }
    if (!teamsReady) return;
    // Not a member of that team — nothing to switch to.
    if (allTeams.some((t) => t.id === pendingTeamId)) {
      setShowMe(false);
      selectTeamAcrossOrgs(pendingTeamId);
    }
    setPendingTeamId(null);
  }, [pendingTeamId, selectedTeamId, allTeams, teamsReady, selectTeamAcrossOrgs]);

  // In memory only: opening one notification shouldn't overwrite the reader's
  // saved Group by. A search that excludes the post would keep its
  // conversation from ever appearing, so it's cleared too.
  useEffect(() => {
    if (!targetPostId) return;
    _setThreadBy('session');
    setSearchQuery('');
  }, [targetPostId]);

  // A boolean, not `posts` itself: the array gets a fresh identity on every DDP
  // change event, and depending on it tore down the effect below (cancelling its
  // rAF) faster than a frame could elapse, so the scroll never ran.
  const targetPostLoaded = targetPostId !== null && posts.some((p) => p.id === targetPostId);

  // Live session state for the inbox titles and the classic card header. The
  // posts publication only fires on post writes, so a clock-out would never
  // reach the feed on its own — `clock.liveForTeams` carries every still-open
  // session for the team(s) in scope.
  const liveTeamIds = useMemo(
    () => (scope === 'me' ? allTeams.map((t) => t.id) : selectedTeamId ? [selectedTeamId] : []),
    [scope, allTeams, selectedTeamId],
  );
  const { docs: liveClockEvents } = useLiveClockEvents(liveTeamIds);

  // Last REST snapshot for the team, replaced wholesale on every refetch (not
  // merged) so an edit or delete that happened while DDP was disconnected is
  // reflected, and a post absent from a later snapshot doesn't linger forever.
  const restPostsRef = useRef<Map<string, HuddlePost>>(new Map());

  // Build the feed from the DDP cache plus any pending overlay posts. Lifted to
  // component scope so handleInboxMessageSent and pull-to-refresh can trigger
  // an immediate re-sync.
  const syncPosts = useCallback(() => {
    if (!selectedTeamId) return;
    const ddp = getDdpClient();
    const byId = new Map<string, HuddlePost>();
    for (const p of ddp.docs('huddlePosts')) {
      if (p.teamId !== selectedTeamId) continue;
      const post = { ...p, id: (p.id ?? p._id) as string } as unknown as HuddlePost;
      byId.set(post.id, post);
    }
    // REST snapshot wins over the DDP cache when it's newer — DDP may be
    // holding a stale copy while the socket is disconnected (e.g. backgrounded
    // for a Pulse recording), so a plain "DDP always wins" merge would hide
    // REST-only edits indefinitely.
    for (const [id, restPost] of restPostsRef.current) {
      const ddpPost = byId.get(id);
      if (
        !ddpPost ||
        new Date(restPost.updatedAt).getTime() > new Date(ddpPost.updatedAt).getTime()
      ) {
        byId.set(id, restPost);
      } else if (restPost.session?.endTime != null && ddpPost.session?.endTime == null) {
        // Clock-out doesn't touch the post, so the DDP copy keeps its open
        // session snapshot; take the closed one from the post-clock-out refetch.
        byId.set(id, { ...ddpPost, session: restPost.session });
      }
    }
    const teamPosts = [...byId.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    setPosts(teamPosts);
  }, [selectedTeamId]);

  // Fetch the feed over REST and overlay it. Used by pull-to-refresh and as a
  // fallback when the live DDP socket is down (dropped while backgrounded for a
  // Pulse recording), so the feed still updates without a reconnect.
  const refreshFeed = useCallback(async () => {
    if (!selectedTeamId) return;
    try {
      const fresh = await huddleApi.getPosts(selectedTeamId);
      restPostsRef.current = new Map(fresh.map((post) => [post.id, post]));
      syncPosts();
    } catch (err) {
      console.error('[Huddle] refreshFeed failed:', err);
    }
  }, [selectedTeamId, syncPosts]);

  // Wire pull-to-refresh (swipe down) to the REST refetch for whichever scope
  // is active.
  const refreshActiveScope = useCallback(
    () => (scope === 'me' ? refreshMyPosts() : refreshFeed()),
    [scope, refreshMyPosts, refreshFeed],
  );
  useRefresh(refreshActiveScope);

  // A post's `session.endTime` is a snapshot from when it was last fetched —
  // clocking out doesn't touch the huddlePosts document, so the change stream
  // behind the posts subscription never fires for it. The live clock event
  // list above drops a session the instant it closes, so refetch only when a
  // session that was open in scope has closed — not on first load, a team
  // switch or a clock-in. In Personal only the caller's own sessions count.
  const liveClockEventIdsKey = liveClockEvents
    .map((d) => `${d._id}:${d.endTime ?? 'open'}`)
    .join(',');
  const openSessionsRef = useRef<Map<string, string>>(new Map());
  const refreshActiveScopeRef = useRef(refreshActiveScope);
  refreshActiveScopeRef.current = refreshActiveScope;
  useEffect(() => {
    const inScope = new Set(liveTeamIds);
    const open = new Map<string, string>();
    for (const d of liveClockEvents) {
      const teamId = String(d.teamId ?? '');
      if (d.endTime != null || !inScope.has(teamId)) continue;
      if (scope === 'me' && d.userId !== user?.id) continue;
      open.set(String(d._id), teamId);
    }
    const previous = openSessionsRef.current;
    openSessionsRef.current = open;
    const closed = [...previous].some(([id, teamId]) => inScope.has(teamId) && !open.has(id));
    if (closed) void refreshActiveScopeRef.current();
  }, [liveClockEventIdsKey, liveTeamIds, scope, user?.id]);

  // Subscribe to live DDP publication for huddle posts
  useEffect(() => {
    if (!selectedTeamId) {
      setPosts([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const ddp = getDdpClient();
    const unsub = ddp.subscribe('huddlePosts.byTeam', [selectedTeamId], () => setLoading(false));

    // Sync immediately in case data is already cached
    syncPosts();

    // REST fallback: populate the feed even if the DDP socket is down (it's
    // dropped while the app is backgrounded for a Pulse recording).
    refreshFeed().finally(() => setLoading(false));

    // Then keep syncing on every change
    const offChange = ddp.onCollectionChange('huddlePosts', syncPosts);

    const loadingFallback = setTimeout(() => setLoading(false), 3000);

    return () => {
      clearTimeout(loadingFallback);
      unsub();
      offChange();
      setPosts([]);
      restPostsRef.current.clear();
    };
  }, [selectedTeamId, syncPosts, refreshFeed]);

  // Posting from the composer above the feed (team scope only — see its JSX
  // below). A post lands in `posts` via the same DDP/REST sync as any other
  // write, so it shows up in the SuperChatInbox the moment it's grouped.
  async function addPost(content: ComposerContent) {
    // Thrown, not alerted: HuddleComposer catches it and shows the reason in
    // its own `role="alert"` region, keeping the draft and the caret intact.
    if (!user || !postingTeamId) {
      throw new Error('Select a team before posting.');
    }

    const mentionUserIds = (content.mentions || []).map((m) => m.userId);
    const attachments = content.attachments.map(toPostAttachment);

    const { id } = await huddleApi.createPost({
      teamId: postingTeamId,
      content: { text: content.text, mentions: mentionUserIds },
      ticketId: content.ticketId,
      attachments,
      postDate: toDateString(new Date()),
    });

    // Show the new post without waiting on the live DDP socket, which may be
    // down (dropped while the app was backgrounded for a Pulse recording):
    // refreshFeed refetches over REST and overlays the result, and syncPosts
    // drops the overlay once the subscription catches up.
    //
    // The retry condition is "not in the feed by *either* route". Waiting on
    // the DDP cache specifically would stall the full backoff on every post
    // whenever the socket is down — which is the exact case the REST overlay
    // exists to cover, and where the post is already on screen after the first
    // refresh.
    const ddp = getDdpClient();
    const inFeed = () =>
      restPostsRef.current.has(id) || ddp.docs('huddlePosts').some((p) => (p.id ?? p._id) === id);

    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 1500));
      await refreshFeed();
      if (inFeed()) break;
    }
    // The Personal ("me") view reads its own cross-team list, not `posts`.
    if (scope === 'me') await refreshMyPosts();
  }

  // The posts driving the inbox: one team's feed, or (in the "Me" scope) the
  // caller's own posts across every team.
  const activePosts = scope === 'me' ? myPosts : posts;

  const filteredPosts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return activePosts;
    return activePosts.filter(
      (post) =>
        post.content.text.toLowerCase().includes(query) ||
        post.userName?.toLowerCase().includes(query) ||
        post.ticketTitle?.toLowerCase().includes(query),
    );
  }, [activePosts, searchQuery]);

  // Team admins (and org owners) get the extra session-title detail (hours,
  // no-wrap-up warning). Not in Personal: `isAdmin` there reflects the
  // Personal team, where everyone is admin, not the posts' source teams.
  const viewerIsAdmin = scope === 'team' && isAdmin;
  const viewer = useMemo(
    () => ({ userId: user?.id ?? '', isAdmin: viewerIsAdmin }),
    [user?.id, viewerIsAdmin],
  );

  // Only the Personal ("me") scope labels messages with their team — a
  // single-team feed already has that context from the page itself.
  const getTeamName = useMemo(() => {
    if (scope !== 'me') return undefined;
    const names = new Map(allTeams.map((t) => [t.id, t.name]));
    return (teamId: string) => names.get(teamId);
  }, [scope, allTeams]);

  // ── SuperChatInbox mapping (memoized — posts update via DDP) ──
  // Keyed on the post arrays themselves: syncPosts/refreshMyPosts replace them
  // on every change, including ones that don't bump `updatedAt` (clock-in
  // linking a plan to its session, clock-out closing it). `nowMinute` keeps a
  // live session's worked duration moving without regrouping every second.
  const nowMinute = Math.floor(currentTime / 60_000) * 60_000;
  const conversations = useMemo(
    () =>
      postsToConversations(filteredPosts, threadBy, viewer, nowMinute, getTeamName, activePosts),
    [filteredPosts, threadBy, viewer, nowMinute, getTeamName, activePosts],
  );
  const renderPlugins = useMemo(
    () => [createCodePlugin(), createImagePlugin(), createMermaidPlugin()],
    [],
  );

  // The conversation the inbox has open (controlled — see onConversationOpened
  // below). Resetting it when the grouping/scope changes avoids pointing at an
  // id from the previous Thread by option, which would just show nothing open.
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(undefined);
  useEffect(() => {
    setActiveConversationId(undefined);
  }, [threadBy, selectedTeamId, scope]);
  // Same fallback SuperChatInbox uses for an unknown id, so the conversation
  // on screen is the one whose permissions decide `readOnly` below.
  const activeConversation =
    conversations.find((c) => c.id === activeConversationId) ?? conversations[0];
  // A Personal-scope conversation spanning several teams has no single team
  // to post to, so it's read-only.
  const teamToPostIn = (conversation: SuperChatConversation) =>
    scope === 'me' ? singleTeamOf(conversation, myPosts) : (selectedTeamId ?? undefined);
  const inboxReadOnly =
    !activeConversation ||
    !teamToPostIn(activeConversation) ||
    !canPostIn(activeConversation, threadBy, viewer);

  // Deep link (see the targetPostId/threadBy effect above): once the post has
  // loaded and the grouping has switched to session, open the conversation
  // that contains it.
  useEffect(() => {
    if (!targetPostId || !targetPostLoaded) return;
    if (threadBy !== 'session') return;
    const match = conversations.find((c) => c.thread.some((m) => m.id === targetPostId));
    if (!match) return;
    setActiveConversationId(match.id);
    setTargetPostId(null);
    replace('/app/huddle');
  }, [targetPostId, targetPostLoaded, threadBy, conversations, replace]);

  // Send from the inbox's message box → huddle.createPost, routed by how the
  // open conversation is grouped (its own clock session, its own ticket, or
  // just the calendar day it represents).
  async function handleInboxMessageSent(
    text: string,
    meta: {
      conversation: SuperChatConversation;
      mentions: string[];
      attachments: ComposerAttachment[];
    },
  ) {
    const targetTeamId = teamToPostIn(meta.conversation);
    if (!user || !targetTeamId) throw new Error('Select a team before posting.');
    setEditError(null);
    try {
      const key = conversationGroupKey(meta.conversation.id);
      // `nosession:<userId>:<YYYY-MM-DD>` — keep the thread's own day so the
      // reply lands in the conversation it was sent from.
      const noSessionDay = key.startsWith('nosession:')
        ? key.slice(key.lastIndexOf(':') + 1)
        : undefined;
      // A reply to a session keeps that session's day, not today's.
      const sessionDay =
        threadBy === 'session' && !noSessionDay
          ? activePosts.find((p) => p.clockEventId === key)?.postDate
          : undefined;
      const postDate =
        threadBy === 'day' ? key : (noSessionDay ?? sessionDay ?? toDateString(new Date()));
      const attachments = await Promise.all(
        meta.attachments.map(async (att) =>
          toPostAttachment(
            await uploadMedia(await fileFromDataUrl(att.name, att.type, att.dataUrl)),
          ),
        ),
      );
      await huddleApi.createPost({
        teamId: targetTeamId,
        content: { text, mentions: meta.mentions },
        postDate,
        attachments,
        ...(threadBy === 'session' && !noSessionDay ? { clockEventId: key } : {}),
        ...(threadBy === 'ticket' && key !== 'none' ? { ticketId: key } : {}),
      });
      await (scope === 'me' ? refreshMyPosts() : refreshFeed());
    } catch (err) {
      console.error('[Huddle] Failed to send message:', err);
      setEditError(composerErrorMessage(err, 'Failed to send. Please try again.'));
      // Rejecting restores the typed text into the composer (SuperChatInbox's
      // onMessageSent contract).
      throw err;
    }
  }

  // Inline edit from the feed (self-authored messages only) → huddle.updatePost
  async function handleMessageEdited(messageId: string, text: string) {
    const post = activePosts.find((p) => p.id === messageId);
    if (!post) return;
    const shown = conversations.flatMap((c) => c.thread).find((m) => m.id === messageId)?.text;
    const body = shown ? stripInboxDecorations(text, shown, post.content.text) : text;
    try {
      await huddleApi.updatePost(messageId, { text: body, mentions: post.content.mentions });
      // REST refresh too: with the DDP socket down (mobile, backgrounded) the
      // saved edit would otherwise stay invisible until a manual refresh.
      await refreshActiveScope();
    } catch (err) {
      console.error('[Huddle] Failed to save edit:', err);
      setEditError(composerErrorMessage(err, 'Failed to save the edit. Please try again.'));
    }
  }

  return (
    <AppPage fill width="wide" hideTitle>
      {/* AppPage's own px-4 md:px-6 covers small screens; these extra
          breakpoints widen the side margins further as the viewport grows,
          instead of leaving them flat past md. */}
      {/* Phones only: clip (not hide) sideways overflow so the page can't be
          dragged horizontally; clip creates no scroll container, so vertical
          scrolling is unchanged. */}
      <div className="huddle flex h-full min-h-0 flex-col gap-4 max-md:overflow-x-clip lg:px-6 xl:px-10 2xl:px-16">
        {/* Actions: Group by, search, notifications */}
        <div className="huddle-actions flex shrink-0 items-center gap-2">
          <ButtonGroup className="ms-auto">
            <Dropdown
              open={threadByMenuOpen}
              onOpenChange={setThreadByMenuOpen}
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Group by: ${THREAD_BY_LABELS[threadBy]}`}
                >
                  {THREAD_BY_LABELS[threadBy]}
                  <FontAwesomeIcon icon={faChevronDown} className="ms-1.5 text-xs" />
                </Button>
              }
            >
              {THREAD_BY_OPTIONS.map((option) => (
                <DropdownItem
                  key={option}
                  icon={option === threadBy ? <FontAwesomeIcon icon={faCheck} /> : undefined}
                  onClick={() => {
                    setThreadBy(option);
                    // DropdownItem doesn't close its menu on its own.
                    setThreadByMenuOpen(false);
                  }}
                >
                  {THREAD_BY_LABELS[option]}
                </DropdownItem>
              ))}
            </Dropdown>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowSearch(!showSearch)}
              aria-label="Search posts"
              title="Search posts"
            >
              <FontAwesomeIcon icon={faMagnifyingGlass} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate('/app/notifications')}
              aria-label="Notifications"
              title="Notifications"
            >
              <FontAwesomeIcon icon={faBell} />
            </Button>
          </ButtonGroup>
        </div>

        {showSearch && (
          <Input
            label="Search posts"
            hideLabel
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search posts…"
            className="shrink-0"
            autoFocus
          />
        )}

        {/* Team tabs for the inbox. "Personal" is a view (see `showMe`); a
            team tab uses the same setSelectedTeamId the header team switcher
            uses, so the rest of the app stays in sync. Thread by (grouping)
            is the Group by dropdown above, beside search — switching it only
            re-runs postsToConversations, it never refetches. */}
        <div className="huddle-inbox-controls flex shrink-0 flex-col gap-2">
          <Tabs
            variant="pills"
            value={scope === 'me' ? PERSONAL_TAB : (selectedTeamId ?? '')}
            onValueChange={selectTab}
          >
            <TabsList aria-label="Team" className="flex-wrap">
              <TabsTrigger value={PERSONAL_TAB}>Personal</TabsTrigger>
              {teamTabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {/* Composer for a team's very first post — sits right below the team
            tabs above. Once a team has any posts, replying happens from
            inside the conversation it belongs to; showing this composer too
            would just be a second way to do the same thing. In the Personal
            ("me") view it shows only while you have no posts anywhere, and
            posts to your Personal team. min-h-0 lets it shrink and scroll its
            own overflow on a short viewport instead of clipping its lower
            half (the attach buttons, Cancel and Post) under the nav. */}
        {postingTeamId &&
          !(scope === 'me' ? myPostsLoading : loading) &&
          activePosts.length === 0 && (
            <div className="huddle-composer min-h-0 max-h-[70vh] shrink-0 overflow-y-auto overscroll-contain">
              <HuddleComposer
                key={postingTeamId}
                onPost={addPost}
                userInitials={user ? getUserInitials(user.name) : 'U'}
                userColor={user ? getUserColor(user.id) : 'indigo'}
              />
            </div>
          )}

        {/* Feed */}
        <div className="huddle-feed min-h-0 flex-1 overflow-y-auto">
          {scope === 'team' && !selectedTeamId && (
            <div className="flex items-center justify-center py-16 px-4">
              <p className="text-sm text-gray-500 dark:text-neutral-400">
                Please select a team to view the huddle feed
              </p>
            </div>
          )}

          {(scope === 'me' || selectedTeamId) && (
            <>
              {(scope === 'me' ? myPostsLoading : loading) && (
                <div className="flex items-center justify-center py-16">
                  <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                </div>
              )}

              {(scope === 'me' ? myPostsError : error) && (
                <div className="flex items-center justify-center py-16 px-4">
                  <p className="text-sm text-red-500 dark:text-red-400">
                    {scope === 'me' ? myPostsError : error}
                  </p>
                </div>
              )}

              <ComposerError message={editError} onDismiss={() => setEditError(null)} />

              {!(scope === 'me' ? myPostsLoading : loading) &&
                !(scope === 'me' ? myPostsError : error) &&
                activePosts.length === 0 && (
                  <EmptyState
                    title={scope === 'me' ? 'No posts in the last 30 days' : 'No posts yet'}
                    description={
                      scope === 'me'
                        ? 'Personal shows what you posted in any team over the last 30 days.'
                        : 'Be the first to share an update.'
                    }
                  />
                )}

              {!(scope === 'me' ? myPostsLoading : loading) &&
                !(scope === 'me' ? myPostsError : error) &&
                activePosts.length > 0 &&
                filteredPosts.length === 0 && (
                  <EmptyState title="No matching posts" description="Try a different search." />
                )}

              {/* SuperChatInbox, grouped by the selected Thread by option.
                  Writable only where posting makes sense (see canPostIn):
                  the composer is read-only everywhere else, and the
                  component shows its own read-only placeholder. */}
              {!(scope === 'me' ? myPostsLoading : loading) &&
                !(scope === 'me' ? myPostsError : error) &&
                user &&
                filteredPosts.length > 0 && (
                  <SuperChatInbox
                    conversations={conversations}
                    activeConversationId={activeConversation?.id}
                    onConversationOpened={(conversation) =>
                      setActiveConversationId(conversation.id)
                    }
                    currentParticipantId={user.id}
                    readOnly={inboxReadOnly}
                    virtualized
                    renderPlugins={renderPlugins}
                    onMessageSent={(text, meta) => handleInboxMessageSent(text, meta)}
                    onMessageEdited={(messageId, text) => void handleMessageEdited(messageId, text)}
                    className="h-full"
                  />
                )}
            </>
          )}
        </div>
      </div>
    </AppPage>
  );
}
