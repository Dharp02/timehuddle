import { beforeEach, describe, expect, it } from 'vitest';

import { forgetReturnTo, rememberReturnTo, restoreReturnTo } from './returnTo';

describe('returnTo', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('brings the browser back to a remembered app link, once', () => {
    window.history.replaceState(null, '', '/app/tickets/abc?team=t1');
    rememberReturnTo();
    window.history.replaceState(null, '', '/');

    expect(restoreReturnTo()).toBe(true);
    expect(window.location.pathname + window.location.search).toBe('/app/tickets/abc?team=t1');

    window.history.replaceState(null, '', '/app/dashboard');
    expect(restoreReturnTo()).toBe(false);
    expect(window.location.pathname).toBe('/app/dashboard');
  });

  it('ignores pages outside the app', () => {
    window.history.replaceState(null, '', '/release-notes');
    rememberReturnTo();
    expect(restoreReturnTo()).toBe(false);
  });

  it('forgets the link on an explicit sign-out', () => {
    window.history.replaceState(null, '', '/app/teams/t1');
    rememberReturnTo();
    forgetReturnTo();
    expect(restoreReturnTo()).toBe(false);
  });
});
