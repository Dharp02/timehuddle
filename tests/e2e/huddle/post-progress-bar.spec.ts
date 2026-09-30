/**
 * Huddle — Post Progress Bar
 *
 * Verifies that submitting a text post shows the progress bar
 * (`data-testid="post-progress-bar"`) while the request is in flight and
 * that the post appears in the feed once the bar completes.
 *
 * Also covers the busy, disabled submit button so double-submits can't happen.
 *
 * Driven through the Clock tab's plan composer (the shared progress bar), with
 * the shared team's plan gate on; the post is read back from the Huddle inbox.
 */
import { expect, test } from '@playwright/test';
import { TEST_USERS, loginAs } from '../fixtures/users';
import { selectSharedTestTeam } from '../fixtures/team';
import {
  clockOut,
  composerEditor,
  openComposer,
  openPostInInbox,
  postButton,
  setSharedTeamPlanGate,
} from './helpers';

test.describe('Huddle — post progress bar', () => {
  test.beforeAll(() => setSharedTeamPlanGate(true));
  test.afterAll(() => setSharedTeamPlanGate(false));

  test.beforeEach(async ({ page }) => {
    await loginAs(page, TEST_USERS.owner1);
    await selectSharedTestTeam(page);
    await openComposer(page);
  });

  test.afterEach(async ({ page }) => {
    await clockOut(page);
  });

  test('progress bar appears while posting and disappears after post lands in feed', async ({
    page,
  }) => {
    const postText = `Progress bar test ${Date.now()}`;

    await composerEditor(page).fill(postText);

    // Race: watch for the progress bar the instant Post is clicked so we
    // don't miss its brief appearance on a fast local backend.
    const progressBar = page.locator('[data-testid="post-progress-bar"]');
    const progressVisible = progressBar.waitFor({ state: 'visible', timeout: 5000 });

    await postButton(page).click();

    // Progress bar must appear
    await progressVisible;

    // Progress bar disappears once the post resolves
    await progressBar.waitFor({ state: 'hidden', timeout: 15000 });

    // Post must appear in the feed
    await openPostInInbox(page, postText);
  });

  test('the post button is disabled while posting to prevent double-submit', async ({ page }) => {
    const postText = `Double-submit guard ${Date.now()}`;

    await composerEditor(page).fill(postText);

    const button = postButton(page);
    await expect(button).toBeEnabled();

    // Located by its busy state, not its label: while loading the button shows
    // a spinner, which can change its accessible name.
    const busy = page.locator('.clock-plan-composer button[aria-busy="true"]');
    const disabledPromise = expect(busy).toBeDisabled();

    await button.click();
    await disabledPromise;

    // Wait for completion
    await page.locator('[data-testid="post-progress-bar"]').waitFor({
      state: 'hidden',
      timeout: 15000,
    });
  });
});
