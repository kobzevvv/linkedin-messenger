/**
 * Health check module — tests critical LinkedIn selectors against live pages.
 *
 * When a selector breaks, captures DOM context (nearby classes, sample elements,
 * container HTML) so the repair engine can figure out what changed.
 */

const SELECTORS = [
  // Inbox page
  {
    selector: 'ul[aria-label="Conversation List"]',
    page: 'inbox',
    description: 'Inbox list container',
  },
  {
    selector: '.msg-conversations-container__conversations-list > li.msg-conversation-listitem',
    page: 'inbox',
    description: 'Conversation items',
  },
  {
    selector: '.msg-conversation-listitem__link',
    page: 'inbox',
    description: 'Click target for conversations',
  },
  // Thread page (requires clicking into a conversation first)
  {
    selector: 'h2.msg-entity-lockup__entity-title',
    page: 'thread',
    description: 'Thread name header',
  },
  {
    selector: 'ul.msg-s-message-list-content',
    page: 'thread',
    description: 'Message list',
  },
  {
    selector: '.msg-s-message-group__name',
    page: 'thread',
    description: 'Sender name in message group',
  },
  {
    selector: '.msg-s-event-listitem__body',
    page: 'thread',
    description: 'Message body',
  },
  {
    selector: '.msg-s-message-list__event--outbound',
    page: 'thread',
    description: 'Outbound message class',
  },
  {
    selector: '[role="textbox"][aria-label="Write a message…"]',
    page: 'thread',
    description: 'Compose box',
  },
  {
    selector: '.msg-form__send-button',
    page: 'thread',
    description: 'Send button',
  },
  // Hiring page
  {
    selector: '[role="button"][aria-label="View full profile"]',
    page: 'hiring',
    description: 'Applicant profile cards',
  },
  // Shared (non-critical)
  {
    selector: '.artdeco-dropdown--is-open .artdeco-dropdown__trigger',
    page: 'shared',
    description: 'Dropdown close trigger (non-critical)',
    optional: true,
  },
];

/**
 * Extract the BEM-style class root from a selector.
 * e.g. '.msg-conversation-listitem__link' → 'msg-conversation'
 */
function extractClassRoot(selector) {
  const classMatch = selector.match(/\.([\w-]+)/);
  if (!classMatch) return null;
  const full = classMatch[1];
  // Take prefix before first __ (BEM block) or first -- (modifier)
  const blockEnd = full.indexOf('__');
  if (blockEnd > 0) return full.substring(0, blockEnd);
  const modEnd = full.indexOf('--');
  if (modEnd > 0) return full.substring(0, modEnd);
  // If it has hyphens, take first two segments
  const parts = full.split('-');
  if (parts.length >= 3) return parts.slice(0, 3).join('-');
  return full;
}

/**
 * Capture DOM context for a broken selector — enough info for Claude to
 * figure out what LinkedIn renamed.
 */
async function captureDomContext(page, selector) {
  const classRoot = extractClassRoot(selector);

  const context = await page.evaluate(({ selector, classRoot }) => {
    const result = { selector, classRoot, relatedClasses: [], sampleElements: [], containerHtml: '' };

    // 1. Find all classes on the page that contain the root string
    if (classRoot) {
      const allElements = document.querySelectorAll('*');
      const classSet = new Set();
      for (const el of allElements) {
        for (const cls of el.classList) {
          if (cls.includes(classRoot)) classSet.add(cls);
        }
        if (classSet.size > 30) break;
      }
      result.relatedClasses = [...classSet].slice(0, 30);
    }

    // 2. Sample 5 elements from main content area
    const main = document.querySelector('main') || document.body;
    const interesting = main.querySelectorAll('[role], [aria-label], [class*="msg-"], [class*="artdeco-"]');
    for (let i = 0; i < Math.min(interesting.length, 5); i++) {
      const el = interesting[i];
      result.sampleElements.push({
        tag: el.tagName.toLowerCase(),
        classes: [...el.classList].join(' '),
        role: el.getAttribute('role') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        outerHtml: el.outerHTML.substring(0, 300),
      });
    }

    // 3. First 2KB of main innerHTML
    result.containerHtml = (main.innerHTML || '').substring(0, 2048);

    return result;
  }, { selector, classRoot });

  return context;
}

/**
 * Test a single selector on the page.
 * @returns {{ ok: boolean, count: number }}
 */
async function testSelector(page, selector, timeoutMs = 5000) {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ timeout: timeoutMs });
    const count = await page.locator(selector).count();
    return { ok: true, count };
  } catch {
    return { ok: false, count: 0 };
  }
}

/**
 * Run full health check against live LinkedIn pages.
 *
 * @param {import('playwright-core').Page} page - Playwright page connected to LinkedIn
 * @param {object} opts
 * @param {number} opts.timeout - Per-selector timeout in ms (default: 5000)
 * @param {function} opts.log - Logger
 * @returns {Promise<{ ok: boolean, results: object[], broken: object[] }>}
 */
export async function runHealthCheck(page, { timeout = 5000, log = console.log } = {}) {
  log('[health-check] Starting selector health check...');

  const results = [];
  const broken = [];

  // ── Phase 1: Inbox selectors ──
  log('[health-check] Navigating to /messaging/...');
  await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const inboxSelectors = SELECTORS.filter(s => s.page === 'inbox');
  for (const entry of inboxSelectors) {
    const result = await testSelector(page, entry.selector, timeout);
    const record = { ...entry, ...result };
    results.push(record);
    if (!result.ok && !entry.optional) {
      log(`[health-check]   BROKEN: ${entry.selector} (${entry.description})`);
      record.domContext = await captureDomContext(page, entry.selector);
      broken.push(record);
    } else {
      log(`[health-check]   OK: ${entry.selector} (count=${result.count})`);
    }
  }

  // ── Phase 2: Thread selectors (click first conversation) ──
  log('[health-check] Opening first conversation for thread selectors...');
  let threadReachable = false;
  try {
    const firstConv = page.locator('.msg-conversation-listitem__link').first();
    await firstConv.evaluate(el => el.click());
    await page.waitForTimeout(2000);
    threadReachable = true;
  } catch {
    log('[health-check]   Could not open a conversation — thread selectors will be skipped or marked broken');
  }

  const threadSelectors = SELECTORS.filter(s => s.page === 'thread');
  for (const entry of threadSelectors) {
    if (!threadReachable) {
      const record = { ...entry, ok: false, count: 0, skipped: true };
      record.domContext = await captureDomContext(page, entry.selector);
      results.push(record);
      broken.push(record);
      continue;
    }
    const result = await testSelector(page, entry.selector, timeout);
    const record = { ...entry, ...result };
    results.push(record);
    if (!result.ok && !entry.optional) {
      log(`[health-check]   BROKEN: ${entry.selector} (${entry.description})`);
      record.domContext = await captureDomContext(page, entry.selector);
      broken.push(record);
    } else {
      log(`[health-check]   OK: ${entry.selector} (count=${result.count})`);
    }
  }

  // ── Phase 3: Shared selectors (test on current page) ──
  const sharedSelectors = SELECTORS.filter(s => s.page === 'shared');
  for (const entry of sharedSelectors) {
    // Shared/optional selectors — just test, don't mark broken
    const result = await testSelector(page, entry.selector, 2000);
    results.push({ ...entry, ...result });
  }

  // ── Skip hiring selectors (requires a jobId — tested separately if needed) ──
  const hiringSelectors = SELECTORS.filter(s => s.page === 'hiring');
  for (const entry of hiringSelectors) {
    results.push({ ...entry, ok: null, count: 0, skipped: true, reason: 'requires jobId' });
  }

  const ok = broken.length === 0;
  log(`[health-check] Done. ${results.length} selectors tested, ${broken.length} broken.`);
  return { ok, results, broken };
}

export { SELECTORS };
