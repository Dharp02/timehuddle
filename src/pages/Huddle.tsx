import {
  faBell,
  faComments,
  faMagnifyingGlass,
  faTableList,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Button, Input, Tabs, TabsList, TabsTrigger } from '@mieweb/ui';
import { SuperChatInbox } from '@mieweb/ui/components/SuperChat';
import type { ComposerAttachment, SuperChatConversation } from '@mieweb/ui/components/SuperChat';
import {
  createCodePlugin,
  createImagePlugin,
  createMermaidPlugin,
} from '@mieweb/ui/components/SuperChat/plugins';
import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { HuddleComposer } from '../features/huddle/HuddleComposer';
import { DraftsPanel } from '../features/huddle/DraftsPanel';
import { PostCard } from '../features/huddle/PostCard';
import { fileFromDataUrl, toPostAttachment, uploadMedia } from '../features/huddle/api';
import { ComposerError } from '../features/huddle/ComposerError';
import { composerErrorMessage } from '../features/huddle/composerErrors';
import { getUserColor, getUserInitials } from '../features/huddle/avatar';
import {
  canPostIn,
  conversationGroupKey,
  postsToConversations,
  type ThreadBy,
} from '../features/huddle/superChatFeed';
import type { ComposerContent } from '../features/huddle/types';
import { AppPage } from '../ui/AppPage';
import { useRouter } from '../ui/router';
import { useSession } from '@lib/useSession';
import { useTeam } from '@lib/TeamContext';
import { teamApi, huddleApi, type HuddlePost, type Team } from '@lib/api';
import { getDdpClient, useLiveClockEvents } from '@lib/ddp';
import { useRefresh } from '@lib/RefreshContext';
import { toDateString } from '@lib/timeUtils';

const THREAD_BY_KEY = 'app:huddleThreadBy';
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
  const [team, setTeam] = useState<Team | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Top-level tab: the team feed or the user's private drafts.
  const [feedTab, setFeedTab] = useState<'feed' | 'drafts'>('feed');
  // Feed view: the SuperChatInbox thread (default) or the classic card view —
  // the card view keeps per-post comments/likes, which SuperChat has no
  // per-message-thread concept for (deliberately not force-fit).
  const [feedView, setFeedView] = useState<'chat' | 'cards'>('chat');
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
  const { selectedTeamId, setSelectedTeamId, teams, allTeams, setSelectedOrgId, teamsReady } =
    useTeam();

  // Deep-link support: /app/huddle?postId=XXX&teamId=YYY (e.g. from the
  // dashboard's Recent Activity feed, or a clock-in/out or huddle-comment
  // notification) — switch to the post's team, then scroll to and briefly
  // highlight it once loaded, then strip the query params.
  // Re-derived from `search` (not just mount) so tapping a second notification
  // while already on this page is honored.
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
      setPendingTeamId(null);
      return;
    }
    if (!teamsReady) return;
    const inScope = teams.some((t) => t.id === pendingTeamId);
    const crossOrg = inScope ? null : allTeams.find((t) => t.id === pendingTeamId);
    if (!inScope && !crossOrg) {
      setPendingTeamId(null); // not a member of that team — nothing to switch to
      return;
    }
    // A team outside the selected org is filtered out of `teams` and would be
    // reset straight back by TeamContext, so switch the org along with it.
    if (crossOrg) setSelectedOrgId(crossOrg.orgId);
    setSelectedTeamId(pendingTeamId);
    setPendingTeamId(null);
  }, [
    pendingTeamId,
    selectedTeamId,
    teams,
    allTeams,
    teamsReady,
    setSelectedTeamId,
    setSelectedOrgId,
  ]);

  // Carries a nonce, not just the id: re-tapping the same notification while
  // its highlight is still up would otherwise be a no-op state write, and
  // neither the scroll nor the expiry effect below would re-run.
  const [highlight, setHighlight] = useState<{ postId: string; nonce: number } | null>(null);
  const highlightedPostId = highlight?.postId ?? null;

  useEffect(() => {
    if (!targetPostId) return;
    setFeedTab('feed');
    setFeedView('cards');
  }, [targetPostId]);

  // A boolean, not `posts` itself: the array gets a fresh identity on every DDP
  // change event, and depending on it tore down the effect below (cancelling its
  // rAF) faster than a frame could elapse, so the scroll never ran.
  const targetPostLoaded = targetPostId !== null && posts.some((p) => p.id === targetPostId);

  useEffect(() => {
    if (!targetPostId || !targetPostLoaded) return;
    if (feedTab !== 'feed' || feedView !== 'cards') return;

    setHighlight((prev) => ({ postId: targetPostId, nonce: (prev?.nonce ?? 0) + 1 }));
    setTargetPostId(null);
    replace('/app/huddle');
  }, [targetPostId, targetPostLoaded, feedTab, feedView, replace]);

  // Scrolling hangs off the highlight rather than the target: clearing
  // `targetPostId` above re-runs that effect, and its cleanup would cancel the
  // pending animation frame before the card had a chance to mount.
  useEffect(() => {
    if (!highlight) return;
    const { postId } = highlight;
    let frame = 0;
    let attempts = 0;
    const tryScroll = () => {
      const el = document.getElementById(`huddle-post-${postId}`);
      if (!el) {
        if (attempts++ < 60) frame = requestAnimationFrame(tryScroll);
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    frame = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(frame);
  }, [highlight]);

  // Long enough to survive a scroll animation and catch the eye. Deliberately
  // not dismissed on tap — the tap that opened the notification arrives here as
  // a ghost event and was killing the highlight instantly on touch devices.
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 6000);
    return () => clearTimeout(timer);
  }, [highlight]);

  // Live session state for the post headers. The posts publication only fires
  // on post writes, so a clock-out would never reach the feed on its own —
  // `clock.liveForTeams` carries every still-open session for the team.
  const liveTeamIds = useMemo(() => (selectedTeamId ? [selectedTeamId] : []), [selectedTeamId]);
  const { docs: liveClockEvents } = useLiveClockEvents(liveTeamIds);
  const activeClockEventIds = useMemo(
    () => new Set(liveClockEvents.filter((d) => d.endTime == null).map((d) => d._id)),
    [liveClockEvents],
  );

  // Load team data for permission checks
  useEffect(() => {
    async function loadTeam() {
      if (!selectedTeamId) {
        setTeam(null);
        return;
      }

      try {
        const teams = await teamApi.getTeamsOnly();
        const foundTeam = teams.find((t) => t.id === selectedTeamId);
        setTeam(foundTeam || null);
      } catch (err) {
        console.error('[Huddle] Failed to load team:', err);
      }
    }

    loadTeam();
  }, [selectedTeamId]);

  // Last REST snapshot for the team, replaced wholesale on every refetch (not
  // merged) so an edit or delete that happened while DDP was disconnected is
  // reflected, and a post absent from a later snapshot doesn't linger forever.
  const restPostsRef = useRef<Map<string, HuddlePost>>(new Map());

  // Build the feed from the DDP cache plus any pending overlay posts. Lifted to
  // component scope so addPost can trigger an immediate re-sync after posting.
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

  // Wire pull-to-refresh (swipe down) to the REST refetch.
  useRefresh(refreshFeed);

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

  async function addPost(content: ComposerContent) {
    // Thrown, not alerted: HuddleComposer catches it and shows the reason in
    // its own `role="alert"` region, keeping the draft and the caret intact.
    if (!user || !selectedTeamId) {
      throw new Error('Select a team before posting.');
    }

    const mentionUserIds = (content.mentions || []).map((m) => m.userId);
    const attachments = content.attachments.map(toPostAttachment);

    const { id } = await huddleApi.createPost({
      teamId: selectedTeamId,
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
      if (inFeed()) return;
    }
  }

  // Determine permissions for each post
  function canEditPost(post: HuddlePost): boolean {
    if (!user || !team) return false;
    const isAuthor = post.userId === user.id;
    const isTeamAdmin = team.admins.includes(user.id);
    const isOrgOwner =
      user.organizationMembership?.role === 'owner' &&
      user.organizationMembership?.organizationId === team.orgId;
    return isAuthor || isTeamAdmin || isOrgOwner;
  }

  function canDeletePost(post: HuddlePost): boolean {
    // Same permissions as edit
    return canEditPost(post);
  }

  const filteredPosts = posts.filter((post) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      post.content.text.toLowerCase().includes(query) ||
      post.userName?.toLowerCase().includes(query) ||
      post.ticketTitle?.toLowerCase().includes(query)
    );
  });

  // The selected team's admins list gates the extra title detail
  // (hours, no-wrap-up warning) postsToConversations shows admins on session
  // threads.
  const isAdmin = !!(user && team?.admins.includes(user.id));
  const viewer = useMemo(() => ({ userId: user?.id ?? '', isAdmin }), [user?.id, isAdmin]);

  // ── SuperChatInbox mapping (memoized — posts update via DDP) ──
  // Keyed by an id:updatedAt fingerprint instead of the array identity,
  // because filteredPosts is a fresh array every render.
  const conversationKey = filteredPosts.map((p) => `${p.id}:${p.updatedAt}`).join(',');
  const conversations = useMemo(
    () => postsToConversations(filteredPosts, threadBy, viewer),
    [conversationKey, threadBy, viewer],
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
  }, [threadBy, selectedTeamId]);
  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const inboxReadOnly = !activeConversation || !canPostIn(activeConversation, threadBy, viewer);

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
    if (!user || !selectedTeamId) throw new Error('Select a team before posting.');
    setEditError(null);
    try {
      const key = conversationGroupKey(meta.conversation.id);
      const postDate = threadBy === 'day' ? key : toDateString(new Date());
      const attachments = await Promise.all(
        meta.attachments.map(async (att) =>
          toPostAttachment(
            await uploadMedia(await fileFromDataUrl(att.name, att.type, att.dataUrl)),
          ),
        ),
      );
      await huddleApi.createPost({
        teamId: selectedTeamId,
        content: { text, mentions: meta.mentions },
        postDate,
        attachments,
        ...(threadBy === 'session' && !key.startsWith('nosession:') ? { clockEventId: key } : {}),
        ...(threadBy === 'ticket' && key !== 'none' ? { ticketId: key } : {}),
      });
      await refreshFeed();
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
    const post = posts.find((p) => p.id === messageId);
    if (!post) return;
    try {
      await huddleApi.updatePost(messageId, { text, mentions: post.content.mentions });
    } catch (err) {
      console.error('[Huddle] Failed to save edit:', err);
      setEditError(composerErrorMessage(err, 'Failed to save the edit. Please try again.'));
    }
  }

  return (
    <AppPage fill flush>
      <div className="huddle flex h-full min-h-0 flex-col gap-4 md:mx-auto md:w-full md:max-w-4xl md:px-6 md:pb-6">
        {/* Feed / Drafts tabs + actions */}
        <div className="huddle-actions flex shrink-0 items-center gap-2 px-4 md:px-0">
          <Tabs
            variant="pills"
            value={feedTab}
            onValueChange={(v) => setFeedTab(v as 'feed' | 'drafts')}
          >
            <TabsList aria-label="Huddle feed or drafts" className="w-fit">
              <TabsTrigger value="feed">Feed</TabsTrigger>
              <TabsTrigger value="drafts">Drafts</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="ml-auto flex items-center gap-2">
            {feedTab === 'feed' && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setFeedView(feedView === 'chat' ? 'cards' : 'chat')}
                  aria-label={feedView === 'chat' ? 'Switch to card view' : 'Switch to chat view'}
                  title={
                    feedView === 'chat' ? 'Card view (comments & likes)' : 'Chat view (rich thread)'
                  }
                >
                  <FontAwesomeIcon icon={feedView === 'chat' ? faTableList : faComments} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowSearch(!showSearch)}
                  aria-label="Search posts"
                  title="Search posts"
                >
                  <FontAwesomeIcon icon={faMagnifyingGlass} />
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate('/app/notifications')}
              aria-label="Notifications"
              title="Notifications"
            >
              <FontAwesomeIcon icon={faBell} />
            </Button>
          </div>
        </div>

        {showSearch && feedTab === 'feed' && (
          <Input
            label="Search posts"
            hideLabel
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search posts…"
            className="shrink-0 mx-4 md:mx-0"
            autoFocus
          />
        )}

        {/* Thread by (grouping) + Scope (team) tabs for the inbox. Switching
            Thread by only re-runs postsToConversations above — it never
            refetches. Scope keeps the rest of the app in sync by calling the
            same setSelectedTeamId the header team switcher uses. */}
        {feedTab === 'feed' && feedView === 'chat' && (
          <div className="huddle-inbox-controls flex shrink-0 flex-col gap-2 px-4 md:px-0">
            <Tabs
              variant="pills"
              value={threadBy}
              onValueChange={(v) => setThreadBy(v as ThreadBy)}
            >
              <TabsList aria-label="Thread by" className="flex-wrap">
                {THREAD_BY_OPTIONS.map((option) => (
                  <TabsTrigger key={option} value={option}>
                    {THREAD_BY_LABELS[option]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Tabs
              variant="pills"
              value={selectedTeamId ?? ''}
              onValueChange={(v) => setSelectedTeamId(v)}
            >
              <TabsList aria-label="Scope" className="flex-wrap">
                {teams.map((t) => (
                  <TabsTrigger key={t.id} value={t.id}>
                    {t.name}
                  </TabsTrigger>
                ))}
                <TabsTrigger value="me" disabled>
                  Me · all teams
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        )}

        {/* Drafts tab — private, multiple drafts */}
        {selectedTeamId && feedTab === 'drafts' && user && (
          <div className="px-4 md:px-0">
            <DraftsPanel
              teamId={selectedTeamId}
              userInitials={getUserInitials(user.name)}
              userColor={getUserColor(user.id)}
            />
          </div>
        )}

        {/* Composer stays put while the feed below it scrolls.
            On a short viewport the expanded composer is taller than the space
            between the header and the fixed bottom nav, so it must be able to
            shrink and scroll its own overflow — otherwise its lower half (the
            attach buttons, Cancel and Post) is clipped under the nav and
            unreachable. min-h-0 is what lets a flex child shrink below its
            content height. */}
        {selectedTeamId && feedTab === 'feed' && (
          <div className="huddle-composer min-h-0 max-h-[70vh] overflow-y-auto overscroll-contain">
            <HuddleComposer
              key={selectedTeamId}
              onPost={addPost}
              userInitials={user ? getUserInitials(user.name) : 'U'}
              userColor={user ? getUserColor(user.id) : 'indigo'}
            />
          </div>
        )}

        {/* Feed */}
        {feedTab === 'feed' && (
          <div className="huddle-feed min-h-0 flex-1 overflow-y-auto">
            {!selectedTeamId && (
              <div className="flex items-center justify-center py-16 px-4">
                <p className="text-sm text-gray-500 dark:text-neutral-400">
                  Please select a team to view the huddle feed
                </p>
              </div>
            )}

            {selectedTeamId && (
              <>
                {loading && (
                  <div className="flex items-center justify-center py-16">
                    <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}

                {error && (
                  <div className="flex items-center justify-center py-16 px-4">
                    <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
                  </div>
                )}

                <ComposerError message={editError} onDismiss={() => setEditError(null)} />

                {!loading && !error && posts.length === 0 && (
                  <div className="flex items-center justify-center py-16 px-4">
                    <p className="text-sm text-gray-500 dark:text-neutral-400">
                      No posts yet. Be the first to share!
                    </p>
                  </div>
                )}

                {/* Chat view — SuperChatInbox, grouped by the selected
                  Thread by option. Writable only where posting makes sense
                  (see canPostIn): the composer is read-only everywhere else,
                  and the component shows its own read-only placeholder. */}
                {!loading && !error && user && posts.length > 0 && feedView === 'chat' && (
                  <SuperChatInbox
                    conversations={conversations}
                    activeConversationId={activeConversationId}
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

                {/* Classic card view — keeps per-post comments and likes */}
                {!loading &&
                  !error &&
                  user &&
                  feedView === 'cards' &&
                  filteredPosts.map((post) => (
                    <PostCard
                      key={post.id}
                      post={post}
                      currentUserId={user?.id ?? ''}
                      canEdit={canEditPost(post)}
                      canDelete={canDeletePost(post)}
                      highlighted={post.id === highlightedPostId}
                      sessionActive={
                        !!post.clockEventId && activeClockEventIds.has(post.clockEventId)
                      }
                    />
                  ))}
              </>
            )}
          </div>
        )}
      </div>
    </AppPage>
  );
}
