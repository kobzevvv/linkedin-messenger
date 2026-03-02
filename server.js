/**
 * HTTP wrapper around LinkedInMessenger for use by CF Workers.
 *
 * Messaging endpoints:
 *   POST /api/send-message              { threadUrl, text }                → { ok }
 *   GET  /api/thread?url=...&limit=50                                     → { name, profileUrl, messages }
 *   GET  /api/unread                                                      → [{ name, threadUrl, ... }]
 *   POST /api/mark-read                 { threadUrl }                     → { ok }
 *
 * Hiring endpoints:
 *   GET  /api/hiring/applicants?jobId=...                                 → { applicants, lastUpdated, cached }
 *   POST /api/hiring/applicants/refresh?jobId=...                         → { ok } (triggers background scrape)
 *   POST /api/hiring/message            { jobId, applicationId, text }    → { ok, threadUrl }
 *   GET  /api/hiring/messages?jobId=...&inboxDepth=30                     → [{ name, threadUrl, ... }]
 *
 * Start: node server.js
 * Requires Chrome running with --remote-debugging-port=9222
 */

import { readFileSync } from 'fs';
import express from 'express';
import { LinkedInMessenger } from './src/index.js';
import { runHealthCheck } from './src/health-check.js';
import { repairSelectors } from './src/repair.js';

// Load .env file if present (for launchd which bypasses start.sh)
try {
  const envFile = readFileSync('.env', 'utf-8');
  for (const line of envFile.split('\n')) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch {}

const PORT = parseInt(process.env.PORT || '3456', 10);
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const app = express();
app.use(express.json());

let messenger = null;

async function getMessenger() {
  if (!messenger) {
    const m = new LinkedInMessenger({ cdpPort: CDP_PORT });
    await m.connect(); // only assign if connect succeeds
    messenger = m;
  }
  return messenger;
}

// Serialize all Playwright operations — single page, no concurrent access
let queue = Promise.resolve();
function serialized(fn) {
  const task = queue.then(fn);
  queue = task.catch(() => {}); // prevent chain break on error
  return task;
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, connected: !!messenger });
});

// Send message to a thread
app.post('/api/send-message', async (req, res) => {
  const { threadUrl, text } = req.body;
  if (!threadUrl || !text) {
    return res.status(400).json({ error: 'threadUrl and text are required' });
  }
  try {
    const result = await serialized(async () => {
      const m = await getMessenger();
      return m.sendMessage(threadUrl, text);
    });
    res.json(result);
  } catch (err) {
    console.error('[send-message]', err);
    res.status(500).json({ error: err.message });
  }
});

// Get thread messages
app.get('/api/thread', async (req, res) => {
  const url = req.query.url;
  const limit = parseInt(req.query.limit || '50', 10);
  if (!url) {
    return res.status(400).json({ error: 'url query param is required' });
  }
  try {
    const result = await serialized(async () => {
      const m = await getMessenger();
      return m.getThread(url, { limit });
    });
    res.json(result);
  } catch (err) {
    console.error('[thread]', err);
    res.status(500).json({ error: err.message });
  }
});

// Get unread conversations
app.get('/api/unread', async (_req, res) => {
  try {
    const conversations = await serialized(async () => {
      const m = await getMessenger();
      return m.getUnread();
    });
    res.json(conversations);
  } catch (err) {
    console.error('[unread]', err);
    res.status(500).json({ error: err.message });
  }
});

// Mark thread as read
app.post('/api/mark-read', async (req, res) => {
  const { threadUrl } = req.body;
  if (!threadUrl) {
    return res.status(400).json({ error: 'threadUrl is required' });
  }
  try {
    const result = await serialized(async () => {
      const m = await getMessenger();
      return m.markAsRead(threadUrl);
    });
    res.json(result);
  } catch (err) {
    console.error('[mark-read]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Hiring applicants cache ──────────────────────────────────
// Scraping 3 filter groups with scroll takes 2-3 minutes — too slow for
// Cloudflare's 100s timeout. We scrape in background and serve from cache.

const hiringCache = new Map(); // jobId → { data, lastUpdated, scraping }

function getCacheKey(jobId, filter) { return `${jobId}:${filter}`; }

async function scrapeApplicants(jobId, filter, limit) {
  const key = getCacheKey(jobId, filter);
  const entry = hiringCache.get(key) || { data: [], lastUpdated: null, scraping: false };
  if (entry.scraping) return; // already in progress
  entry.scraping = true;
  hiringCache.set(key, entry);

  console.log(`[hiring-cache] Scraping jobId=${jobId} filter=${filter}...`);
  try {
    const applicants = await serialized(async () => {
      const m = await getMessenger();
      return m.getHiringApplicants(jobId, { limit, filter });
    });
    hiringCache.set(key, { data: applicants, lastUpdated: new Date().toISOString(), scraping: false });
    console.log(`[hiring-cache] Cached ${applicants.length} applicants for ${key}`);
  } catch (err) {
    console.error(`[hiring-cache] Scrape failed for ${key}:`, err.message);
    entry.scraping = false;
    hiringCache.set(key, entry);
  }
}

// Get applicants from a job posting (returns cached data)
app.get('/api/hiring/applicants', async (req, res) => {
  const jobUrl = req.query.jobId || req.query.url;
  const limit = parseInt(req.query.limit || '200', 10);
  const filter = req.query.filter || 'all';
  if (!jobUrl) {
    return res.status(400).json({ error: 'jobId or url query param is required' });
  }
  if (!['all', 'top', 'maybe', 'notfit'].includes(filter)) {
    return res.status(400).json({ error: 'filter must be one of: all, top, maybe, notfit' });
  }

  const jobId = jobUrl.match?.(/jobId=(\d+)/)?.[1] || jobUrl;
  const key = getCacheKey(jobId, filter);
  const cached = hiringCache.get(key);

  // Return cached data if fresh (< 10 min)
  if (cached?.lastUpdated) {
    const ageMs = Date.now() - new Date(cached.lastUpdated).getTime();
    if (ageMs < 10 * 60 * 1000) {
      return res.json({
        applicants: cached.data,
        lastUpdated: cached.lastUpdated,
        cached: true,
        count: cached.data.length,
      });
    }
  }

  // Stale or missing — trigger background scrape
  scrapeApplicants(jobId, filter, limit);

  // Return stale data if we have any, otherwise signal scraping in progress
  if (cached?.data?.length) {
    return res.json({
      applicants: cached.data,
      lastUpdated: cached.lastUpdated,
      cached: true,
      stale: true,
      count: cached.data.length,
    });
  }

  res.json({
    applicants: [],
    lastUpdated: null,
    cached: false,
    scraping: true,
    count: 0,
    message: 'First scrape started. Retry in 2-3 minutes.',
  });
});

// Force refresh applicants cache
app.post('/api/hiring/applicants/refresh', async (req, res) => {
  const body = req.body || {};
  const jobUrl = req.query.jobId || body.jobId;
  const filter = req.query.filter || body.filter || 'all';
  const limit = parseInt(req.query.limit || body.limit || '200', 10);
  if (!jobUrl) {
    return res.status(400).json({ error: 'jobId is required' });
  }
  const jobId = jobUrl.match?.(/jobId=(\d+)/)?.[1] || jobUrl;
  scrapeApplicants(jobId, filter, limit);
  res.json({ ok: true, message: 'Refresh started. Check /api/hiring/applicants in 2-3 minutes.' });
});

// Send a message to a hiring applicant (creates new thread)
app.post('/api/hiring/message', async (req, res) => {
  const { jobId, applicationId, text } = req.body;
  if (!jobId || !applicationId || !text) {
    return res.status(400).json({ error: 'jobId, applicationId, and text are required' });
  }
  try {
    const result = await serialized(async () => {
      const m = await getMessenger();
      return m.messageApplicant(jobId, applicationId, text);
    });
    res.json(result);
  } catch (err) {
    console.error('[hiring/message]', err);
    res.status(500).json({ error: err.message });
  }
});

// Get applicants matched with their messaging threads
app.get('/api/hiring/messages', async (req, res) => {
  const jobUrl = req.query.jobId || req.query.url;
  const limit = parseInt(req.query.limit || '200', 10);
  const inboxDepth = parseInt(req.query.inboxDepth || '30', 10);
  const filter = req.query.filter || 'all';
  if (!jobUrl) {
    return res.status(400).json({ error: 'jobId or url query param is required' });
  }
  try {
    const result = await serialized(async () => {
      const m = await getMessenger();
      return m.getHiringMessages(jobUrl, { limit, inboxDepth, filter });
    });
    res.json(result);
  } catch (err) {
    console.error('[hiring/messages]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Logs endpoint ───────────────────────────────────────────

app.get('/api/logs', (_req, res) => {
  const lines = parseInt(_req.query.lines || '100', 10);
  try {
    const log = readFileSync('/tmp/linkedin-messenger-server.log', 'utf-8');
    const tail = log.split('\n').slice(-lines).join('\n');
    res.type('text/plain').send(tail);
  } catch {
    res.status(500).send('Could not read logs');
  }
});

// ── Health check & repair endpoints ──────────────────────────

// Manual health check — tests all selectors against live page
app.get('/api/health-check', async (_req, res) => {
  try {
    const report = await serialized(async () => {
      const m = await getMessenger();
      return runHealthCheck(m.page);
    });
    res.json(report);
  } catch (err) {
    console.error('[health-check]', err);
    res.status(500).json({ error: err.message });
  }
});

// Manual repair — run health check, fix broken selectors, restart if needed
app.post('/api/repair', async (_req, res) => {
  try {
    const report = await serialized(async () => {
      const m = await getMessenger();
      return runHealthCheck(m.page);
    });

    if (report.ok) {
      return res.json({ repaired: false, message: 'All selectors OK', report });
    }

    const result = await repairSelectors(report.broken);

    if (result.repaired) {
      res.on('finish', () => {
        console.log('[repair] Selectors repaired. Exiting with code 75 for restart...');
        setTimeout(() => process.exit(75), 200);
      });
    }
    res.json({ ...result, report });
  } catch (err) {
    console.error('[repair]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Scheduled health check (every 30 min) ──────────────────

let schedulerRunning = false;

async function scheduledHealthCheck() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  console.log('[scheduler] Running scheduled health check...');

  try {
    const report = await serialized(async () => {
      const m = await getMessenger();
      return runHealthCheck(m.page);
    });

    if (report.ok) {
      console.log('[scheduler] All selectors OK.');
      return;
    }

    console.log(`[scheduler] ${report.broken.length} broken selector(s) found.`);

    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('[scheduler] ANTHROPIC_API_KEY not set — cannot auto-repair. Fix selectors manually.');
      return;
    }

    const result = await repairSelectors(report.broken);
    if (result.repaired) {
      console.log('[scheduler] Selectors repaired. Exiting with code 75 for restart...');
      setTimeout(() => process.exit(75), 500);
    }
  } catch (err) {
    console.error('[scheduler] Health check failed:', err.message);
  } finally {
    schedulerRunning = false;
  }
}

// ── Background cache refresh (every 10 min) ────────────────

async function refreshHiringCaches() {
  if (hiringCache.size === 0) return;
  console.log(`[cache-refresh] Refreshing ${hiringCache.size} cached hiring queries...`);
  for (const [key] of hiringCache) {
    const [jobId, filter] = key.split(':');
    await scrapeApplicants(jobId, filter, 200);
  }
}

// Check every 60s — health check at :00/:30, cache refresh at :05/:15/:25/:35/:45/:55
setInterval(() => {
  const min = new Date().getMinutes();
  if (min === 0 || min === 30) {
    scheduledHealthCheck();
  }
  if (min % 10 === 5) {
    refreshHiringCaches();
  }
}, 60_000);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (messenger) await messenger.disconnect();
  process.exit(0);
});

app.listen(PORT, async () => {
  console.log(`LinkedIn Messenger HTTP server listening on port ${PORT}`);
  console.log(`Chrome CDP port: ${CDP_PORT}`);

  // Connect to Chrome eagerly so /health shows connected: true immediately
  try {
    await getMessenger();
    console.log('Chrome connected.');
  } catch (err) {
    console.warn(`Chrome not available at startup: ${err.message}. Will retry on first request.`);
  }
});
