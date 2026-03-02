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
 * - getHiringApplicants(jobUrl) → list of applicants from a job posting
 * - getHiringMessages(jobUrl)   → applicants matched with messaging threads
 * - messageApplicant(jobId, applicationId, text) → message an applicant via hiring page
 *
 * All methods use Playwright to interact with linkedin.com/messaging/ and /hiring/.
 * The Chrome instance must be started with --remote-debugging-port.
 */
export class LinkedInMessenger {
  /**
   * @param {object} opts
   * @param {number} opts.cdpPort - Chrome DevTools Protocol port (default: 9222)
   * @param {number} opts.timeout - Default timeout for operations in ms (default: 10000)
   * @param {function} opts.log - Logger function (default: console.log with [LM] prefix)
   */
  constructor({ cdpPort = 9222, timeout = 10000, log } = {}) {
    this.cdpPort = cdpPort;
    this.timeout = timeout;
    this.browser = null;
    this.context = null;
    this.page = null;
    this._log = log || ((...args) => console.log('[LM]', ...args));
  }

  /** Connect to running Chrome via CDP */
  async connect() {
    this._log(`Connecting to Chrome CDP on port ${this.cdpPort}...`);
    this.browser = await chromium.connectOverCDP(`http://localhost:${this.cdpPort}`);
    this.context = this.browser.contexts()[0];
    if (!this.context) throw new Error('No browser context found. Is Chrome running?');

    // Use existing page or create new one
    const pages = this.context.pages();
    this.page = pages.find(p => p.url().includes('linkedin.com/messaging')) || await this.context.newPage();
    this.page.setDefaultTimeout(this.timeout);
    this._log(`Connected. Page: ${this.page.url()}`);
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
    this._log(`getInbox(limit=${limit})`);
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

    this._log(`getInbox → ${conversations.length} conversations`);
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
    this._log(`getThread(${threadUrl.substring(0, 80)}, limit=${limit})`);
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

    this._log(`getThread → ${result.name}, ${result.messages.length} messages`);
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
    this._log(`sendMessage(${threadUrl.substring(0, 80)}, "${text.substring(0, 40)}...")`);
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

    this._log('sendMessage → sent');
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

  // ── Hiring / Applicants ──────────────────────────────────────

  /**
   * Get applicants from a LinkedIn job posting's hiring page.
   *
   * @param {string} jobUrl - Full hiring URL (with jobId) or just the jobId
   * @param {object} opts
   * @param {number} opts.limit - Max applicants to return (default: 25)
   * @param {string} opts.filter - Which filter groups to fetch: 'all' | 'top' | 'maybe' | 'notfit' (default: 'all')
   * @returns {Promise<Array<{
   *   name: string,
   *   title: string,
   *   location: string,
   *   connectionDegree: string,
   *   applicationId: string,
   *   contacted: boolean,
   *   contactedTime: string,
   *   appliedTime: string,
   *   fitCategory: string,
   * }>>}
   */
  async getHiringApplicants(jobUrl, { limit = 25, filter = 'all' } = {}) {
    this._log(`getHiringApplicants(jobUrl=${String(jobUrl).substring(0, 60)}, limit=${limit}, filter=${filter})`);
    const jobId = typeof jobUrl === 'string' && jobUrl.startsWith('http')
      ? jobUrl.match(/jobId=(\d+)/)?.[1] || jobUrl
      : String(jobUrl);

    if (!jobId) throw new Error('Could not extract jobId from URL');

    // Rating param tells LinkedIn which filter to show by default
    const ratingMap = { top: 'GOOD_FIT', maybe: 'MAYBE', notfit: 'NOT_FIT' };
    const ratingParam = ratingMap[filter] ? `&rating=${ratingMap[filter]}` : '';

    await this.page.goto(
      `https://www.linkedin.com/hiring/applicants/?jobId=${jobId}${ratingParam}`,
      { waitUntil: 'domcontentloaded' },
    );
    await this.page.waitForTimeout(3000);

    // Wait for applicant list
    await this.page.locator('[role="button"][aria-label="View full profile"]')
      .first()
      .waitFor({ timeout: this.timeout });

    // Scroll to load all lazy-loaded applicant cards
    await this._scrollApplicantList();

    // First pass: parse applicant metadata from the list
    const listData = await this.page.evaluate((limit) => {
      const btns = document.querySelectorAll('[role="button"][aria-label="View full profile"]');
      const results = [];

      for (const btn of btns) {
        if (results.length >= limit) break;
        const container = btn.closest('li') || btn.parentElement?.parentElement?.parentElement;
        if (!container) continue;

        const text = container.innerText || '';
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

        let name = '';
        let connectionDegree = '';
        let title = '';
        let location = '';

        for (let j = 0; j < lines.length; j++) {
          const line = lines[j];
          if (line.match(/^·\s*\d+\w+$/)) {
            connectionDegree = line.replace(/^·\s*/, '');
            continue;
          }
          if (line.match(/^\d+\/\d+$/) || line === 'Must-have' || line === 'Preferred') break;

          if (!name) {
            name = line;
          } else if (!title) {
            title = line;
          } else if (!location) {
            location = line;
          }
        }

        results.push({ name, connectionDegree, title, location });
      }

      return results;
    }, limit);

    this._log(`  ${listData.length} cards found (filter=${filter})`);

    // Second pass: click each to get applicationId and contacted status
    const allApplicants = [];
    const profileBtns = this.page.locator('[role="button"][aria-label="View full profile"]');

    for (let i = 0; i < listData.length; i++) {
      if (allApplicants.length >= limit) break;

      await profileBtns.nth(i).click();
      await this.page.waitForTimeout(1500);

      const url = this.page.url();
      const applicationId = url.match(/applicationId=(\d+)/)?.[1] || '';

      const status = await this.page.evaluate(() => {
        const text = document.body.innerText;
        const resumeIdx = text.indexOf('Resume');
        const qualIdx = text.indexOf('Qualifications', resumeIdx);
        const panel = resumeIdx >= 0
          ? text.substring(resumeIdx, qualIdx > resumeIdx ? qualIdx : resumeIdx + 500)
          : '';
        const appliedMatch = panel.match(/Applied (.+?)(?:\s*·|\n|$)/);
        const contactedMatch = panel.match(/Contacted (.+?)(?:\s*·|\n|$)/);
        return {
          appliedTime: appliedMatch?.[1]?.trim() || '',
          contacted: !!contactedMatch,
          contactedTime: contactedMatch?.[1]?.trim() || '',
        };
      });

      // Detect fit category from URL rating param or page content
      const fitCategory = url.match(/rating=(\w+)/)?.[1] || filter;

      this._log(`  [${allApplicants.length + 1}] ${listData[i].name} → appId=${applicationId} ${status.contacted ? '✓contacted' : ''}`);
      allApplicants.push({ ...listData[i], applicationId, ...status, fitCategory });
    }

    this._log(`getHiringApplicants → ${allApplicants.length} applicants`);
    return allApplicants;
  }

  /**
   * Scroll the applicant list container to load all lazy-loaded cards.
   */
  async _scrollApplicantList() {
    const maxScrollAttempts = 20;
    for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
      const countBefore = await this.page.locator('[role="button"][aria-label="View full profile"]').count();

      // Scroll the list container (or fallback to window)
      await this.page.evaluate(() => {
        const listContainer = document.querySelector('[class*="applicant-list"]')
          || document.querySelector('[class*="hiring-applicants"]')
          || document.querySelector('main');
        if (listContainer) {
          listContainer.scrollTop = listContainer.scrollHeight;
        }
        window.scrollTo(0, document.body.scrollHeight);
      });
      await this.page.waitForTimeout(1000);

      const countAfter = await this.page.locator('[role="button"][aria-label="View full profile"]').count();
      if (countAfter === countBefore) break; // No new cards loaded
      this._log(`  Scrolled: ${countBefore} → ${countAfter} cards`);
    }
  }

  /**
   * Get applicants from a hiring page matched with their messaging threads.
   * Fetches the applicant list, then scans the messaging inbox to find
   * existing conversations with those applicants by name.
   *
   * @param {string} jobUrl - Full hiring URL (with jobId) or just the jobId
   * @param {object} opts
   * @param {number} opts.limit - Max applicants (default: 25)
   * @param {number} opts.inboxDepth - How many inbox conversations to scan (default: 30)
   * @returns {Promise<Array<{
   *   name: string,
   *   title: string,
   *   location: string,
   *   applicationId: string,
   *   threadUrl: string | null,
   *   lastMessage: string,
   *   lastMessageFrom: 'them' | 'me' | null,
   * }>>}
   */
  async getHiringMessages(jobUrl, { limit = 25, inboxDepth = 30, filter = 'all' } = {}) {
    // Step 1: Get applicant list
    const applicants = await this.getHiringApplicants(jobUrl, { limit, filter });

    // Step 2: Scan messaging inbox
    const inbox = await this.getInbox({ limit: inboxDepth });

    // Step 3: Match by name (exact full-name first, then whole-word last name)
    this._log(`Matching ${applicants.length} applicants against ${inbox.length} inbox threads`);
    for (const applicant of applicants) {
      const fullName = applicant.name.toLowerCase();
      const nameParts = applicant.name.split(/\s+/);
      const lastName = nameParts[nameParts.length - 1]?.toLowerCase();
      const lastNameRegex = lastName?.length >= 2 ? new RegExp(`\\b${lastName}\\b`) : null;

      const match = inbox.find(c => {
        const cName = c.name.toLowerCase();
        if (cName === fullName) return true;
        return lastNameRegex ? lastNameRegex.test(cName) : false;
      });

      if (match) {
        this._log(`  ✓ ${applicant.name} → matched inbox: "${match.name}"`);
        applicant.threadUrl = match.threadUrl;
        applicant.lastMessage = match.lastMessage;
        applicant.lastMessageFrom = match.lastMessageFrom;
      } else {
        applicant.threadUrl = null;
        applicant.lastMessage = '';
        applicant.lastMessageFrom = null;
      }
    }

    const matched = applicants.filter(a => a.threadUrl).length;
    this._log(`getHiringMessages → ${matched}/${applicants.length} matched with inbox`);
    return applicants;
  }

  /**
   * Send a message to a hiring applicant via the LinkedIn Hiring page.
   * Opens the applicant's profile, clicks "Message", types text, and sends.
   *
   * @param {string} jobId - LinkedIn job ID
   * @param {string} applicationId - Applicant's application ID
   * @param {string} text - Message text to send
   * @returns {Promise<{ ok: boolean, threadUrl: string }>}
   */
  async messageApplicant(jobId, applicationId, text) {
    this._log(`messageApplicant(jobId=${jobId}, appId=${applicationId}, text="${text.substring(0, 40)}...")`);
    // Navigate to the specific applicant's profile on the hiring page
    const url = `https://www.linkedin.com/hiring/applicants/?jobId=${jobId}&applicationId=${applicationId}`;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);

    // Open Contact dropdown, then click Message
    this._log('  Opening Contact → Message...');
    const contactBtn = this.page.getByRole('button', { name: 'Contact' });
    await contactBtn.waitFor({ timeout: this.timeout });
    await contactBtn.click();
    await this.page.waitForTimeout(500);

    const messageBtn = this.page.getByRole('menuitem', { name: 'Message' });
    await messageBtn.waitFor({ timeout: this.timeout });
    await messageBtn.click();
    await this.page.waitForTimeout(2000);

    // Wait for the messaging overlay / compose box to appear
    const textbox = this.page.locator('[role="textbox"]').first();
    await textbox.waitFor({ timeout: this.timeout });
    await textbox.click();
    await textbox.fill(text);
    await this.page.waitForTimeout(500);

    // Click "Send" button — prefer the compose-form-specific class, fallback to text match
    const sendBtn = this.page.locator('.msg-form__send-button, button[type="submit"]').first()
      .or(this.page.locator('button').filter({ hasText: /^Send$/ }).first());
    await sendBtn.waitFor({ timeout: this.timeout });
    await sendBtn.click();
    await this.page.waitForTimeout(2000);

    // Extract thread URL from the page — look for messaging thread link/URL
    // After sending, LinkedIn often shows the conversation. Try to get thread URL.
    const currentUrl = this.page.url();
    let threadUrl = '';

    // Check if we're redirected to a messaging thread
    const threadMatch = currentUrl.match(/\/messaging\/thread\/([^/]+)/);
    if (threadMatch) {
      threadUrl = `https://www.linkedin.com/messaging/thread/${threadMatch[1]}/`;
    } else {
      // Try to find thread URL in the messaging overlay
      const threadLink = await this.page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/messaging/thread/"]');
        if (links.length > 0) return links[links.length - 1].href;
        return '';
      });
      threadUrl = threadLink;
    }

    // If we still don't have a threadUrl, navigate to messaging inbox and find by name match
    if (!threadUrl) {
      // Get the applicant name from the hiring page before navigating away
      const applicantName = await this.page.evaluate(() => {
        const h1 = document.querySelector('h1');
        return h1?.textContent?.trim() || '';
      });

      if (applicantName) {
        await this.page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(2000);
        await this.page.locator('ul[aria-label="Conversation List"]')
          .waitFor({ timeout: this.timeout }).catch(() => {});

        // Find conversation by name match — don't blindly click the first one
        const nameParts = applicantName.toLowerCase().split(/\s+/);
        const lastName = nameParts[nameParts.length - 1];
        const listItems = this.page.locator('.msg-conversations-container__conversations-list > li.msg-conversation-listitem');
        const count = await listItems.count();

        for (let i = 0; i < Math.min(count, 10); i++) {
          const convName = await listItems.nth(i).locator('h3').textContent().catch(() => '');
          if (convName && convName.toLowerCase().includes(lastName)) {
            const clickTarget = listItems.nth(i).locator('.msg-conversation-listitem__link').first();
            await clickTarget.evaluate(el => el.click());
            await this.page.waitForTimeout(1000);
            const msgUrl = this.page.url();
            const match = msgUrl.match(/\/messaging\/thread\/([^/]+)/);
            if (match) {
              threadUrl = `https://www.linkedin.com/messaging/thread/${match[1]}/`;
            }
            break;
          }
        }
      }
    }

    this._log(`messageApplicant → sent, threadUrl=${threadUrl || 'not found'}`);
    return { ok: true, threadUrl };
  }

  /** Disconnect from Chrome */
  async disconnect() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
