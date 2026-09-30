/**
 * useSessionPost — the caller's published Huddle post linked to a clock
 * session (by clockEventId), kept live via the `huddlePosts.byTeam` DDP
 * publication (oplog/change-stream backed).
 *
 * Backs the per-session plan-first gate: clock-out requires this session's
 * post to have a wrap-up. Realtime — the wrap-up flips the gate with no
 * reload.
 */
import { useEffect, useState } from 'react';

import type { HuddlePost } from './api';
import { getDdpClient } from './ddp';

export function useSessionPost(teamId: string | null, clockEventId: string | null) {
  const [sessionPost, setSessionPost] = useState<HuddlePost | null>(null);

  useEffect(() => {
    if (!teamId || !clockEventId) {
      setSessionPost(null);
      return;
    }

    const ddp = getDdpClient();

    const sync = () => {
      const match = ddp
        .docs('huddlePosts')
        .map((p) => ({ ...p, id: (p.id ?? p._id) as string }) as unknown as HuddlePost)
        .filter((p) => p.teamId === teamId && p.clockEventId === clockEventId)
        // Same pick as the server's SESSION_POST_SORT: the wrap-up post, else the
        // earliest (the plan) — later posts are inbox replies, not the plan.
        .sort(
          (a, b) =>
            Number(!!b.wrapUpAt) - Number(!!a.wrapUpAt) ||
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
      setSessionPost(match[0] ?? null);
    };

    const unsubscribe = ddp.subscribe('huddlePosts.byTeam', [teamId], sync);
    const offChange = ddp.onCollectionChange('huddlePosts', sync);
    sync();

    return () => {
      offChange();
      unsubscribe();
      setSessionPost(null);
    };
  }, [teamId, clockEventId]);

  return { sessionPost };
}
