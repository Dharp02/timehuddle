/**
 * useReleaseCelebration — confetti the first time a browser sees a new release.
 *
 * The marker lives in localStorage rather than on the user, because this is a
 * property of the *install*, not the account: a phone that just took an OTA
 * update should celebrate, and a second browser on the same account should too.
 * It is deliberately separate from `releaseNotesSeenVersion`, which answers a
 * different question (what has this person read) and drives the "New" badges.
 */
import { useEffect } from 'react';

import { RELEASE_CELEBRATED_KEY } from '../../lib/constants';

const APP_VERSION = import.meta.env.VITE_APP_VERSION || '1.0.0';

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** Two bursts from the lower corners, so nothing covers the notes being read. */
async function fireConfetti(): Promise<void> {
  const { default: confetti } = await import('canvas-confetti');
  const shared = { particleCount: 60, spread: 70, startVelocity: 45, ticks: 180 };
  void confetti({ ...shared, origin: { x: 0.1, y: 0.9 }, angle: 60 });
  void confetti({ ...shared, origin: { x: 0.9, y: 0.9 }, angle: 120 });
}

/**
 * Fires once per version per browser. Reading and writing the marker in the
 * same effect means a remount within the session is a no-op, not a second show.
 */
export function useReleaseCelebration(): void {
  useEffect(() => {
    let celebrated: string | null = null;
    try {
      celebrated = localStorage.getItem(RELEASE_CELEBRATED_KEY);
      if (celebrated === APP_VERSION) return;
      localStorage.setItem(RELEASE_CELEBRATED_KEY, APP_VERSION);
    } catch {
      // Private mode or a blocked store: skip rather than confetti every visit.
      return;
    }

    if (prefersReducedMotion()) return;
    void fireConfetti();
  }, []);
}
