import { chromium } from 'playwright-core';

/**
 * LinkedIn Messenger — automation layer over LinkedIn messaging UI.
 *
 * Connects to a running Chrome instance via CDP and provides:
 * - getInbox(limit)     → list of recent conversations with previews
 * - getUnread()         → only unread conversations
 * - getThread(threadUrl, limit) → full message history of a conversation
 * - sendMessage(threadUrl, text) → send a message in an existing thread
 * - markAsRead(threadUrl) → open thread to mark it as read
 *
 * All methods use Playwright to interact with linkedin.com/messaging/.
 * The Chrome instance must be started with --remote-debugging-port.
 */
export class LinkedInMessenger {
  /**
   * @param {object} opts
   * @param {number} opts.cdpPort - Chrome DevTools Protocol port (default: 9222)
   * @param {number} opts.timeout - Default timeout for operations in ms (default: 10000)
   */
  constructor({ cdpPort = 9222, timeout = 10000 } = {}) {
    this.cdpPort = cdpPort;
    this.timeout = timeout;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /** Connect to running Chrome via CDP */
  async connect() {
    this.browser = await chromium.connectOverCDP(`http://localhost:${this.cdpPort}`);
    this.context = this.browser.contexts()[0];
    if (!this.context) throw new Error('No browser context found. Is Chrome running?');

    // Use existing page or create new one
    const pages = this.context.pages();
    this.page = pages.find(p => p.url().includes('linkedin.com/messaging')) || await this.context.newPage();
    this.page.setDefaultTimeout(this.timeout);
  }

  /** Navigate to LinkedIn messaging if not already there */
  async _ensureMessagingPage() {
    if (!this.page.url().includes('linkedin.com/messaging')) {
      await this.page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded' });
    }
    await this.page.locator('ul[aria-label="Conversation List"]')
      .waitFor({ timeout: this.timeout });
    await this.page.waitForTimeout(1000);

    // Close any open dropdowns that might intercept clicks
    await this.page.evaluate(() => {
      document.querySelectorAll('.artdeco-dropdown--is-open .artdeco-dropdown__trigger')
        .forEach(el => el.click());
    });
    await this.page.waitForTimeout(300);
  }

  /**
   * Parse conversation metadata from a list item (no clicking).
   * @private
   */
  _parseConversationItem() {
    return (item) => {
      const nameEl = item.querySelector('h3');
      const name = nameEl?.textContent?.trim() || '';
      if (!name) return null;

      // Last message preview
      const previewEl = item.querySelector('p');
      let lastMessage = previewEl?.textContent?.trim() || '';

      // Determine who sent the last message
      let lastMessageFrom = 'them';
      if (lastMessage.startsWith('You: ')) {
        lastMessageFrom = 'me';
        lastMessage = lastMessage.replace(/^You: /, '');
      } else {
        // Format is "Name: message" for their messages
        const colonIdx = lastMessage.indexOf(': ');
        if (colonIdx > 0 && colonIdx < 40) {
          lastMessage = lastMessage.substring(colonIdx + 2);
        }
      }

      // Timestamp
      const timeEl = item.querySelector('time');
      const lastMessageTime = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';

      // Unread badge — look for the notification count text
      let unreadCount = 0;
      const allSpans = item.querySelectorAll('span');
      for (const span of allSpans) {
        const text = span.textContent?.trim();
        const match = text?.match(/^(\d+) (new notification|unread message)/);
        if (match) {
          unreadCount = parseInt(match[1]) || 0;
          break;
        }
      }
      const isUnread = unreadCount > 0;

      return { name, lastMessage, lastMessageTime, lastMessageFrom, isUnread, unreadCount };
    };
  }

  /**
   * Get recent conversations from inbox.
   * Clicks each conversation to resolve threadUrl from the URL bar.
   *
   * @param {object} opts
   * @param {number} opts.limit - Max conversations to return (default: 10)
   * @returns {Promise<Array<{
   *   name: string,
   *   threadUrl: string,
   *   lastMessage: string,
   *   lastMessageTime: string,
   *   lastMessageFrom: 'them' | 'me',
   *   isUnread: boolean,
   *   unreadCount: number
   * }>>}
   */
  async getInbox({ limit = 10 } = {}) {
    await this._ensureMessagingPage();

    // First pass: collect metadata from DOM (fast, no navigation)
    const metadata = await this.page.evaluate((limit) => {
      const items = document.querySelectorAll('.msg-conversations-container__conversations-list > li.msg-conversation-listitem');
      const results = [];

      for (const item of items) {
        if (results.length >= limit) break;

        const nameEl = item.querySelector('h3');
        const name = nameEl?.textContent?.trim() || '';
        if (!name) continue;

        const previewEl = item.querySelector('p');
        let lastMessage = previewEl?.textContent?.trim() || '';

        let lastMessageFrom = 'them';
        if (lastMessage.startsWith('You: ')) {
          lastMessageFrom = 'me';
          lastMessage = lastMessage.replace(/^You: /, '');
        } else {
          const colonIdx = lastMessage.indexOf(': ');
          if (colonIdx > 0 && colonIdx < 40) {
            lastMessage = lastMessage.substring(colonIdx + 2);
          }
        }

        const timeEl = item.querySelector('time');
        const lastMessageTime = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';

        let unreadCount = 0;
        const allSpans = item.querySelectorAll('span');
        for (const span of allSpans) {
          const text = span.textContent?.trim();
          const match = text?.match(/^(\d+) (new notification|unread message)/);
          if (match) {
            unreadCount = parseInt(match[1]) || 0;
            break;
          }
        }

        results.push({ name, lastMessage, lastMessageTime, lastMessageFrom, isUnread: unreadCount > 0, unreadCount });
      }

      return results;
    }, limit);

    // Second pass: click each conversation to get threadUrl
    const conversations = [];
    const listItems = this.page.locator('.msg-conversations-container__conversations-list > li.msg-conversation-listitem');

    for (let i = 0; i < metadata.length; i++) {
      const item = listItems.nth(i);
      // Click via JS to avoid overlay interception
      const clickTarget = item.locator('.msg-conversation-listitem__link').first();
      await clickTarget.evaluate(el => el.click());
      await this.page.waitForTimeout(600);

      // Read threadUrl from browser URL
      const url = this.page.url();
      const threadMatch = url.match(/\/messaging\/thread\/([^/]+)/);
      const threadUrl = threadMatch
        ? `https://www.linkedin.com/messaging/thread/${threadMatch[1]}/`
        : url;

      conversations.push({ ...metadata[i], threadUrl });
    }

    return conversations;
  }

  /**
   * Get only unread conversations.
   * Uses the Unread filter tab.
   * @returns {Promise<Array>} Same format as getInbox
   */
  async getUnread() {
    await this._ensureMessagingPage();

    // Click "Unread" filter
    const unreadBtn = this.page.getByRole('button', { name: 'Unread', exact: true });
    await unreadBtn.click();
    await this.page.waitForTimeout(1500);

    const conversations = await this.getInbox({ limit: 50 });

    // Reset filter back to default — use exact match to avoid "Page inboxes" button
    const inboxBtn = this.page.getByRole('button', { name: 'Inbox', exact: true });
    await inboxBtn.click();
    await this.page.waitForTimeout(500);

    return conversations;
  }

  /**
   * Get full message history of a specific thread.
   *
   * @param {string} threadUrl - Full thread URL or just the thread ID
   * @param {object} opts
   * @param {number} opts.limit - Max messages to return (default: 50)
   * @returns {Promise<{
   *   name: string,
   *   profileUrl: string,
   *   messages: Array<{
   *     from: 'them' | 'me',
   *     senderName: string,
   *     text: string,
   *     timestamp: string
   *   }>
   * }>}
   */
  async getThread(threadUrl, { limit = 50 } = {}) {
    const url = threadUrl.startsWith('http')
      ? threadUrl
      : `https://www.linkedin.com/messaging/thread/${threadUrl}/`;

    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2000);

    // Extract thread data using accessibility tree (more reliable than CSS classes)
    const result = await this.page.evaluate((limit) => {
      // Name from thread header h2
      const h2 = document.querySelector('h2.msg-entity-lockup__entity-title');
      const name = h2?.textContent?.trim() || '';

      // Profile URL from the header link
      const profileLink = document.querySelector('a[href*="/in/"]');
      const profileUrl = profileLink?.href || '';

      // Messages from the thread list
      const msgList = document.querySelector('ul.msg-s-message-list-content');
      if (!msgList) return { name, profileUrl, messages: [] };

      const listItems = msgList.querySelectorAll(':scope > li');
      const messages = [];
      let currentSender = '';
      let currentTimestamp = '';

      for (const li of listItems) {
        if (messages.length >= limit) break;

        // Check for sender name (message group header)
        const senderEl = li.querySelector('.msg-s-message-group__name, [class*="message-group__name"]');
        if (senderEl) currentSender = senderEl.textContent?.trim() || currentSender;

        // Check for timestamp
        const timeEl = li.querySelector('time');
        if (timeEl) currentTimestamp = timeEl.getAttribute('datetime') || timeEl.textContent?.trim() || currentTimestamp;

        // Get message text(s) — a single li can contain multiple messages from same sender
        const msgBodies = li.querySelectorAll('.msg-s-event-listitem__body p, .msg-s-event-listitem__body');
        for (const body of msgBodies) {
          const text = body.textContent?.trim();
          if (!text || text.length < 2) continue;

          // Detect if this is an outbound (sent) message
          const isOutbound = li.closest('.msg-s-message-list__event--outbound') !== null
            || li.classList.contains('msg-s-message-list__event--outbound');

          messages.push({
            from: isOutbound ? 'me' : 'them',
            senderName: currentSender,
            text,
            timestamp: currentTimestamp,
          });
        }
      }

      return { name, profileUrl, messages };
    }, limit);

    return result;
  }

  /**
   * Send a message in an existing thread.
   *
   * @param {string} threadUrl - Full thread URL or thread ID
   * @param {string} text - Message text to send
   * @returns {Promise<{ ok: boolean }>}
   */
  async sendMessage(threadUrl, text) {
    const url = threadUrl.startsWith('http')
      ? threadUrl
      : `https://www.linkedin.com/messaging/thread/${threadUrl}/`;

    // Navigate to thread if not already there
    const currentThreadId = this.page.url().match(/\/messaging\/thread\/([^/]+)/)?.[1];
    const targetThreadId = url.match(/\/messaging\/thread\/([^/]+)/)?.[1];

    if (currentThreadId !== targetThreadId) {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(2000);
    }

    // Find the message textbox and type
    const textbox = this.page.locator('[role="textbox"][aria-label="Write a message…"]');
    await textbox.waitFor({ timeout: this.timeout });
    await textbox.click();
    await textbox.fill(text);
    await this.page.waitForTimeout(300);

    // Send with Enter
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(1000);

    return { ok: true };
  }

  /**
   * Mark a thread as read by opening it.
   *
   * @param {string} threadUrl - Full thread URL or thread ID
   * @returns {Promise<{ ok: boolean }>}
   */
  async markAsRead(threadUrl) {
    const url = threadUrl.startsWith('http')
      ? threadUrl
      : `https://www.linkedin.com/messaging/thread/${threadUrl}/`;

    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1500);
    return { ok: true };
  }

  /** Disconnect from Chrome */
  async disconnect() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
