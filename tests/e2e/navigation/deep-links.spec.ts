/**
 * Deep-link E2E tests (#618).
 *
 * The URL is the source of truth for the selected team: `?team=` wins over the
 * team remembered in localStorage, survives reload and sidebar navigation, and
 * a team the user can't access is never swapped for another one.
 * See src/ui/ROUTING.md.
 */
import { expect, test, type Page } from '@playwright/test';
import { MongoClient, ObjectId } from 'mongodb';

import { getTeamIdByCode } from '../fixtures/team';
import { TEST_USERS, loginAs } from '../fixtures/users';

/** A well-formed team id no user belongs to. */
const UNKNOWN_TEAM_ID = 'ffffffffffffffffffffffff';

const teamParam = (page: Page) => new URL(page.url()).searchParams.get('team');

const MONGO_URL =
  process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/timehuddle_test?replicaSet=rs0';

/** Runs `fn` against the test DB's tickets collection. */
async function withTickets<T>(
  fn: (tickets: ReturnType<ReturnType<MongoClient['db']>['collection']>) => Promise<T>,
): Promise<T> {
  const client = await MongoClient.connect(MONGO_URL);
  try {
    return await fn(client.db().collection('tickets'));
  } finally {
    await client.close();
  }
}

const noAccessHeading = (page: Page, what: RegExp) =>
  page.getByRole('heading', { level: 1, name: what });

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

  test('a team the user is not in shows no access, never another team', async ({ page }) => {
    await page.goto(`/app/dashboard?team=${UNKNOWN_TEAM_ID}`);
    await expect(noAccessHeading(page, /have access to this team/)).toBeVisible();
    expect(teamParam(page)).toBe(UNKNOWN_TEAM_ID);

    await page.getByRole('button', { name: 'Go to dashboard' }).click();
    await expect(noAccessHeading(page, /have access to this team/)).toBeHidden();
    await expect.poll(() => teamParam(page)).not.toBe(UNKNOWN_TEAM_ID);
  });
});

test.describe('Deep links: team pages', () => {
  test.setTimeout(60000);

  test.beforeAll(async () => {
    const id = await getTeamIdByCode('TEST01');
    if (!id) throw new Error('Shared seed team TEST01 not found — did global-setup run?');
    sharedTeamId = id;
  });

  test.beforeEach(async ({ page }) => {
    await loginAs(page, TEST_USERS.owner1);
  });

  test('/app/teams redirects to the selected team’s page', async ({ page }) => {
    // Opening a team by link makes it the remembered team…
    await page.goto(`/app/dashboard?team=${sharedTeamId}`);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage)
            .filter((k) => k.startsWith('app:selectedTeamId:'))
            .map((k) => localStorage.getItem(k)),
        ),
      )
      .toEqual([sharedTeamId]);
    // …so a bare /app/teams lands on it.
    await page.goto('/app/teams');
    await expect(page).toHaveURL(new RegExp(`/app/teams/${sharedTeamId}$`));
  });

  test('/app/teams/:teamId opens that team and survives a reload', async ({ page }) => {
    await page.goto(`/app/teams/${sharedTeamId}`);
    await expect(
      page.locator('main').getByText('Test Team Alpha').filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(
      page.locator('aside').getByRole('button', { name: 'Teams', exact: true }),
    ).toHaveAttribute('aria-current', 'page');

    await page.reload();
    await expect(
      page.locator('main').getByText('Test Team Alpha').filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/app/teams/${sharedTeamId}$`));
  });

  test('a team page the user is not in shows no access', async ({ page }) => {
    await page.goto(`/app/teams/${UNKNOWN_TEAM_ID}`);
    await expect(noAccessHeading(page, /have access to this team/)).toBeVisible();
  });
});

test.describe('Deep links: ticket no-access and not-found', () => {
  test.setTimeout(60000);

  // A ticket in a team no test user belongs to.
  const foreignTicketId = new ObjectId();

  test.beforeAll(async () => {
    await withTickets((tickets) =>
      tickets.insertOne({
        _id: foreignTicketId,
        teamId: new ObjectId().toHexString(),
        title: 'Someone else’s ticket',
        status: 'open',
        createdBy: 'nobody',
        createdAt: new Date(),
      }),
    );
  });

  test.afterAll(async () => {
    await withTickets((tickets) => tickets.deleteOne({ _id: foreignTicketId }));
  });

  test.beforeEach(async ({ page }) => {
    await loginAs(page, TEST_USERS.owner1);
  });

  test('a ticket in another team shows no access', async ({ page }) => {
    await page.goto(`/app/tickets/${foreignTicketId.toHexString()}`);
    await expect(noAccessHeading(page, /have access to this ticket/)).toBeVisible();
  });

  test('a ticket that does not exist shows not found, not no access', async ({ page }) => {
    await page.goto(`/app/tickets/${new ObjectId().toHexString()}`);
    await expect(noAccessHeading(page, /ticket doesn.t exist or was deleted/)).toBeVisible();
    await expect(noAccessHeading(page, /have access/)).toBeHidden();
  });

  test('a malformed ticket id shows not found', async ({ page }) => {
    await page.goto('/app/tickets/not-a-ticket');
    await expect(noAccessHeading(page, /ticket doesn.t exist or was deleted/)).toBeVisible();
  });
});
