import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { matchPath, RouterProvider, useQueryParam, useRouter, withQuery } from './router';

describe('matchPath', () => {
  it('extracts named params', () => {
    expect(matchPath('/app/tickets/:ticketId', '/app/tickets/abc123')).toEqual({
      ticketId: 'abc123',
    });
  });

  it('decodes params', () => {
    expect(matchPath('/app/profile/:id', '/app/profile/jane%20doe')).toEqual({ id: 'jane doe' });
  });

  it('ignores a trailing slash', () => {
    expect(matchPath('/app/teams/:teamId', '/app/teams/t1/')).toEqual({ teamId: 't1' });
  });

  it('returns null for a different path', () => {
    expect(matchPath('/app/tickets/:ticketId', '/app/teams/t1')).toBeNull();
  });

  it('returns null for missing or extra segments', () => {
    expect(matchPath('/app/tickets/:ticketId', '/app/tickets')).toBeNull();
    expect(matchPath('/app/tickets/:ticketId', '/app/tickets/a/b')).toBeNull();
  });
});

describe('withQuery', () => {
  it('sets a key and keeps the others', () => {
    expect(withQuery('/app/tickets', '?team=t1', { status: 'open' })).toBe(
      '/app/tickets?team=t1&status=open',
    );
  });

  it('removes keys set to null or empty string', () => {
    expect(withQuery('/app/tickets', '?team=t1&q=x&status=open', { q: '', status: null })).toBe(
      '/app/tickets?team=t1',
    );
  });

  it('returns the bare path when nothing is left', () => {
    expect(withQuery('/app/tickets', '?q=x', { q: null })).toBe('/app/tickets');
  });
});

// ── Hooks ─────────────────────────────────────────────────────────────────────

let api: {
  value: string | null;
  setValue: (v: string | null) => void;
  setPushed: (v: string | null) => void;
};

function Probe() {
  const [value, setValue] = useQueryParam('post', { aliases: ['postId'] });
  const [, setPushed] = useQueryParam('tab', { mode: 'push' });
  const { pathname, search } = useRouter();
  api = { value, setValue, setPushed };
  return <div data-testid="url">{pathname + search}</div>;
}

function renderAt(url: string) {
  window.history.replaceState(null, '', url);
  render(
    <RouterProvider>
      <Probe />
    </RouterProvider>,
  );
}

const url = () => screen.getByTestId('url').textContent;

describe('useQueryParam', () => {
  let startLength: number;
  beforeEach(() => {
    startLength = window.history.length;
  });
  afterEach(cleanup);

  it('reads the param, falling back to an alias', () => {
    renderAt('/app/huddle?postId=p1');
    expect(api.value).toBe('p1');
  });

  it('writes the canonical name and drops the alias', () => {
    renderAt('/app/huddle?postId=p1&team=t1');
    act(() => api.setValue('p2'));
    expect(url()).toBe('/app/huddle?team=t1&post=p2');
  });

  it('removes the param when set to null', () => {
    renderAt('/app/huddle?post=p1&team=t1');
    act(() => api.setValue(null));
    expect(url()).toBe('/app/huddle?team=t1');
  });

  it('replace mode adds no history entry; push mode adds one', () => {
    renderAt('/app/huddle');
    act(() => api.setValue('p1'));
    expect(window.history.length).toBe(startLength);
    act(() => api.setPushed('team'));
    expect(window.history.length).toBe(startLength + 1);
    expect(window.location.search).toBe('?post=p1&tab=team');
  });

  it('follows Back/Forward', () => {
    renderAt('/app/huddle');
    act(() => api.setPushed('team'));
    act(() => {
      window.history.replaceState(null, '', '/app/huddle?tab=me');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(url()).toBe('/app/huddle?tab=me');
  });

  it('rewrites a retired route on load', () => {
    renderAt('/app/timesheet');
    expect(url()).toBe('/app/dashboard?view=timesheet');
  });
});
