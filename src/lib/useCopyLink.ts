/**
 * useCopyLink — Copies an absolute link to an in-app path and says so.
 *
 * Every "Copy link" action goes through here, so they all produce the same
 * absolute URL and the same announced feedback (a toast, which is aria-live).
 */
import { useOptionalToast } from '@mieweb/ui';
import { useCallback } from 'react';

/** User-facing copy, kept together for translation. */
export const COPY_LINK_COPY = {
  copied: 'Link copied',
  failed: 'Couldn’t copy the link',
};

/** Absolute URL for an in-app path such as `/app/tickets/abc`. */
export function absoluteAppUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export function useCopyLink(): (path: string) => Promise<void> {
  const toast = useOptionalToast();
  return useCallback(
    async (path: string) => {
      try {
        await navigator.clipboard.writeText(absoluteAppUrl(path));
        toast?.success(COPY_LINK_COPY.copied);
      } catch (err) {
        console.error('[useCopyLink] clipboard write failed:', err);
        toast?.error(COPY_LINK_COPY.failed);
      }
    },
    [toast],
  );
}
