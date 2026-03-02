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
 *   GET  /api/hiring/applicants?jobId=...&limit=25                        → [{ name, title, ... }]
 *   POST /api/hiring/message            { jobId, applicationId, text }    → { ok, threadUrl }
 *   GET  /api/hiring/messages?jobId=...&limit=25&inboxDepth=30            → [{ name, threadUrl, ... }]
 *
 * Start: node server.js
 * Requires Chrome running with --remote-debugging-port=9222
 */

import express from 'express';
import { LinkedInMessenger } from './src/index.js';
import { runHealthCheck } from './src/health-check.js';
import { repairSelectors } from './src/repair.js';

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

// Get applicants from a job posting
app.get('/api/hiring/applicants', async (req, res) => {
  const jobUrl = req.query.jobId || req.query.url;
  const limit = parseInt(req.query.limit || '25', 10);
  const filter = req.query.filter || 'all';
  if (!jobUrl) {
    return res.status(400).json({ error: 'jobId or url query param is required' });
  }
  if (!['all', 'top', 'maybe', 'notfit'].includes(filter)) {
    return res.status(400).json({ error: 'filter must be one of: all, top, maybe, notfit' });
  }
  try {
    const applicants = await serialized(async () => {
      const m = await getMessenger();
      return m.getHiringApplicants(jobUrl, { limit, filter });
    });
    res.json(applicants);
  } catch (err) {
    console.error('[hiring/applicants]', err);
    res.status(500).json({ error: err.message });
  }
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
  const limit = parseInt(req.query.limit || '25', 10);
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
    res.json({ ...result, report });

    if (result.repaired) {
      console.log('[repair] Selectors repaired. Exiting with code 75 for restart...');
      setTimeout(() => process.exit(75), 500);
    }
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

// Check every 60s, fire at :00 and :30
setInterval(() => {
  const min = new Date().getMinutes();
  if (min === 0 || min === 30) {
    scheduledHealthCheck();
  }
}, 60_000);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (messenger) await messenger.disconnect();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`LinkedIn Messenger HTTP server listening on port ${PORT}`);
  console.log(`Chrome CDP port: ${CDP_PORT}`);
});
