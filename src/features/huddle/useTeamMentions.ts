/**
 * useTeamMentions — the team roster as @mention candidates for the Huddle
 * message box.
 *
 * SuperChat derives both its suggestion list and the `mentions` it reports on
 * send from the open conversation's participants, which here are only the
 * people who have already posted in that thread. Huddle mentions are
 * team-wide, so the roster supplies the suggestions and `detect` resolves the
 * sent text against it — SuperChat's own ids still come through and are
 * unioned by the caller.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchTeamMembers } from './api';
import type { TeamMember } from './types';

export interface MentionOption {
  id: string;
  label: string;
}

export interface TeamMentions {
  options: MentionOption[];
  /** Ids of roster members named in `text`, matching SuperChat's own rule. */
  detect: (text: string) => string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function useTeamMentions(teamId: string | null | undefined): TeamMentions {
  const [members, setMembers] = useState<TeamMember[]>([]);

  useEffect(() => {
    if (!teamId) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    fetchTeamMembers(teamId)
      .then((data) => {
        if (!cancelled) setMembers(data);
      })
      .catch((err) => {
        console.error('[useTeamMentions] Failed to load team members:', err);
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  return useMemo(
    () => ({
      options: members.map((member) => ({ id: member.id, label: member.name })),
      detect: (text: string) =>
        members
          // Same token as SuperChat's: `@` plus the first word of the name.
          .filter((member) =>
            new RegExp(
              `(?<![\\w@])${escapeRegExp(`@${member.name.split(' ')[0]}`)}(?![\\w])`,
              'i',
            ).test(text),
          )
          .map((member) => member.id),
    }),
    [members],
  );
}
