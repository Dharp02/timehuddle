/**
 * Whether the `devQuickLogin` one-click role sign-in is allowed on this server.
 *
 * Pure function, no Meteor imports, so it can be unit tested directly (see
 * tests/dev-quick-login.test.ts). Called by the `devQuickLogin` handler itself
 * (registered unconditionally by main.js) before it provisions or signs in
 * anyone, so a no-flag request always gets a real `forbidden` error.
 *
 * On in development, off everywhere else, unless DEV_QUICK_LOGIN_ENABLED=true,
 * which only the PR preview workflow sets. Production and TestFlight must
 * never set it: it lets anyone sign in as an org or enterprise owner.
 *
 * @param {{ isDevelopment: boolean, env: { DEV_QUICK_LOGIN_ENABLED?: string } }} context
 * @returns {boolean}
 */
export function isDevQuickLoginEnabled({ isDevelopment, env }) {
  return isDevelopment || env.DEV_QUICK_LOGIN_ENABLED === 'true';
}
