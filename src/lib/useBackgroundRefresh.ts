/**
 * useBackgroundRefresh — keep a page's data fresh without a reload, cheaply.
 *
 * For data the server cannot push to us (a Redmine issue: Redmine has no
 * webhooks), so the only way to see a change made elsewhere is to ask again.
 * `refresh` runs:
 *
 * - when the tab becomes visible or the window regains focus — the common case,
 *   someone who just did something in another tab and came back;
 * - every `intervalMs` while the tab is visible and the user has done something
 *   (clicked, typed, scrolled) within `idleMs`, so a forgotten tab stops asking;
 *
 * never while `paused` (e.g. while an edit is open, so a refresh cannot move the
 * ground under it), never while one is already running, and at most once per
 * `minGapMs`. A failed refresh (`refresh` resolves false) doubles the polling
 * interval, up to `maxIntervalMs`; a success resets it.
 */
import { useEffect, useRef } from 'react';

export interface BackgroundRefreshOptions {
  intervalMs?: number;
  idleMs?: number;
  minGapMs?: number;
  maxIntervalMs?: number;
  paused?: boolean;
}

/** How often the hook checks whether a poll is due. */
const TICK_MS = 15_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function useBackgroundRefresh(
  refresh: () => Promise<boolean>,
  {
    intervalMs = 5 * 60_000,
    idleMs = 15 * 60_000,
    minGapMs = 30_000,
    maxIntervalMs = 30 * 60_000,
    paused = false,
  }: BackgroundRefreshOptions = {},
): void {
  // Read by the listeners below without re-subscribing them on every change.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let lastRun = Date.now(); // the page has just loaded its data
    let lastActivity = Date.now();
    let failures = 0;
    let running = false;

    const run = async () => {
      if (pausedRef.current || running || document.visibilityState !== 'visible') return;
      if (Date.now() - lastRun < minGapMs) return;
      running = true;
      lastRun = Date.now();
      try {
        failures = (await refreshRef.current()) ? 0 : failures + 1;
      } catch {
        failures += 1;
      } finally {
        running = false;
      }
    };

    const onActivity = () => {
      lastActivity = Date.now();
    };
    const onReturn = () => {
      onActivity();
      void run();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onReturn();
    };
    const tick = () => {
      const now = Date.now();
      if (now - lastActivity > idleMs) return;
      const due = Math.min(intervalMs * 2 ** failures, maxIntervalMs);
      if (now - lastRun >= due) void run();
    };

    for (const type of ACTIVITY_EVENTS)
      window.addEventListener(type, onActivity, { passive: true });
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(tick, TICK_MS);

    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [intervalMs, idleMs, minGapMs, maxIntervalMs]);
}
