/**
 * useTicketVideos — the videos already attached to a ticket, as composer
 * attachments. Picking a ticket for a post pulls these in, so a Pulse video
 * recorded on the ticket shows up in the Huddle post about it.
 */
import { useEffect, useState } from 'react';
import { attachmentApi } from '@lib/api';
import type { MediaItem } from './types';

export function useTicketVideos(ticketId: string | undefined): MediaItem[] {
  const [videos, setVideos] = useState<MediaItem[]>([]);

  useEffect(() => {
    if (!ticketId) {
      setVideos([]);
      return;
    }
    let cancelled = false;
    attachmentApi
      .list('ticket', ticketId)
      .then((attachments) => {
        if (cancelled) return;
        setVideos(
          attachments
            .filter((att) => att.type === 'video')
            .map((att) => ({
              id: att.id,
              url: att.url,
              filename: att.title || 'video',
              type: 'video',
              size: 0, // not reported by the attachments API
              mimeType: 'video/mp4',
            })),
        );
      })
      .catch((err) => {
        console.error('[useTicketVideos] Failed to fetch ticket videos:', err);
        if (!cancelled) setVideos([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  return videos;
}
