/**
 * Deep-link E2E tests (#618).
 *
 * The URL is the source of truth for the selected team: `?team=` wins over the
 * team remembered in localStorage, survives reload and sidebar navigation, and
 * a team the user can't access is never swapped for another one.
 * See src/ui/ROUTING.md.
 */
import { expect, test, type Page } from '@playwright/test';

import { getTeamIdByCode } from '../fixtures/team';
import { TEST_USERS, loginAs } from '../fixtures/users';

/** A well-formed team id no user belongs to. */
const UNKNOWN_TEAM_ID = 'ffffffffffffffffffffffff';

const teamParam = (page: Page) => new URL(page.url()).searchParams.get('team');

let sharedTeamId: string;

test.describe('Deep links: team scope', () => {
  test.setTimeout(60000);

  test.beforeAll(async () => {
    const id = await getTeamIdByCode('TEST01');
    if (!id) throw new Error('Shared seed team TEST01 not found — did global-setup run?');
    sharedTeamId = id;
  });

  test.beforeEach(async ({ page }) => {
    await loginAs(page, TEST_USERS.owner1);
  });

  test('stamps the selected team onto the URL', async ({ page }) => {
    await expect.poll(() => teamParam(page)).toBeTruthy();
  });

  test('?team= selects that team and survives a reload', async ({ page }) => {
    await page.goto(`/app/dashboard?team=${sharedTeamId}`);
    await expect(page.getByText('Test Team Alpha').first()).toBeVisible();

    await page.reload();
    await expect(page.getByText('Test Team Alpha').first()).toBeVisible();
    expect(teamParam(page)).toBe(sharedTeamId);
  });

  test('the legacy ?teamId= alias is normalised to ?team=', async ({ page }) => {
    await page.goto(`/app/dashboard?teamId=${sharedTeamId}`);
    await expect.poll(() => teamParam(page)).toBe(sharedTeamId);
    expect(new URL(page.url()).searchParams.has('teamId')).toBe(false);
  });

  test('sidebar navigation keeps the linked team', async ({ page }) => {
    await page.goto(`/app/dashboard?team=${sharedTeamId}`);
    await expect(page.getByText('Test Team Alpha').first()).toBeVisible();

    await page.locator('aside').getByRole('button', { name: 'Tickets', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/tickets\?/);
    expect(teamParam(page)).toBe(sharedTeamId);
  });

  test('a team the user is not in is never replaced by another team', async ({ page }) => {
    await page.goto(`/app/dashboard?team=${UNKNOWN_TEAM_ID}`);
    // Give TeamContext time to load teams and, if it were going to, fall back.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    expect(teamParam(page)).toBe(UNKNOWN_TEAM_ID);
  });
});
