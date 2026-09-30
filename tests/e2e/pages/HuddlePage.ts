import { type Page, type Locator } from '@playwright/test';
import { BasePage } from './BasePage';
import { openPostInInbox } from '../huddle/helpers';

/**
 * HuddlePage - Page object for the huddle feed (a SuperChatInbox)
 */
export class HuddlePage extends BasePage {
  private readonly teamTabs: Locator;

  constructor(page: Page) {
    super(page);
    this.teamTabs = this.page.getByRole('tablist', { name: 'Team' });
  }

  /**
   * Navigate to huddle page
   */
  async goto() {
    await this.page.goto('/app/huddle');
    await this.waitForLoad();
  }

  /**
   * Wait for huddle page to load. The page has no title of its own (the
   * sidebar already names it), so its Team tab list is the landmark.
   */
  async waitForLoad(timeout = 10000) {
    await this.teamTabs.waitFor({ state: 'visible', timeout });
  }

  /**
   * Navigate via sidebar
   */
  async navigateFromSidebar() {
    await this.page.getByRole('button', { name: /^Huddle$/i }).click();
    await this.waitForLoad();
  }

  /**
   * Check if we're on the huddle page
   */
  async isOnHuddlePage(): Promise<boolean> {
    return await this.teamTabs.isVisible().catch(() => false);
  }

  /**
   * Check if a post with specific text exists in the feed
   */
  async hasPost(text: string): Promise<boolean> {
    try {
      await openPostInInbox(this.page, text);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The full text of the post whose body contains `text`, opened in the inbox.
   */
  async getPostText(text: string): Promise<string> {
    const message = await openPostInInbox(this.page, text);
    return message.innerText();
  }
}
