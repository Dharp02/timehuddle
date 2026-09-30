import { type Page, type Locator } from '@playwright/test';
import { BasePage } from './BasePage';
import { openPostInInbox } from '../huddle/helpers';

/**
 * HuddlePage - Page object for the huddle feed (a SuperChatInbox)
 */
export class HuddlePage extends BasePage {
  private readonly feedTab: Locator;
  private readonly draftsTab: Locator;

  constructor(page: Page) {
    super(page);
    this.feedTab = this.page.getByRole('tab', { name: 'Feed' });
    this.draftsTab = this.page.getByRole('tab', { name: 'Drafts' });
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
   * sidebar already names it), so its Feed tab is the landmark.
   */
  async waitForLoad(timeout = 10000) {
    await this.feedTab.waitFor({ state: 'visible', timeout });
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
    return await this.feedTab.isVisible().catch(() => false);
  }

  /**
   * Click on Feed tab
   */
  async clickFeedTab() {
    await this.feedTab.click();
    await this.page.waitForTimeout(500);
  }

  /**
   * Click on Drafts tab
   */
  async clickDraftsTab() {
    await this.draftsTab.click();
    await this.page.waitForTimeout(500);
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
