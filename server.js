/**
 * HTTP wrapper around LinkedInMessenger for use by CF Workers.
 *
 * Endpoints:
 *   POST /api/send-message    { threadUrl, text }              → { ok: true }
 *   GET  /api/thread?url=...&limit=50                          → { name, profileUrl, messages }
 *   GET  /api/unread                                           → [{ name, threadUrl, ... }]
 *   POST /api/mark-read       { threadUrl }                    → { ok: true }
 *
 * Start: node server.js
 * Requires Chrome running with --remote-debugging-port=9222
 */

import express from 'express';
import { LinkedInMessenger } from './src/index.js';

const PORT = parseInt(process.env.PORT || '3456', 10);
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const app = express();
app.use(express.json());

let messenger = null;

async function getMessenger() {
  if (!messenger) {
    messenger = new LinkedInMessenger({ cdpPort: CDP_PORT });
    await messenger.connect();
    console.log(`Connected to Chrome CDP on port ${CDP_PORT}`);
  }
  return messenger;
}

// Serialize all Playwright operations — single page, no concurrent access
let queue = Promise.resolve();
function serialized(fn) {
  const task = queue.then(fn).catch(fn.__errorHandler || (e => { throw e; }));
  queue = task.catch(() => {}); // prevent chain break
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
  if (!jobUrl) {
    return res.status(400).json({ error: 'jobId or url query param is required' });
  }
  try {
    const applicants = await serialized(async () => {
      const m = await getMessenger();
      return m.getHiringApplicants(jobUrl, { limit });
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
  if (!jobUrl) {
    return res.status(400).json({ error: 'jobId or url query param is required' });
  }
  try {
    const result = await serialized(async () => {
      const m = await getMessenger();
      return m.getHiringMessages(jobUrl, { limit, inboxDepth });
    });
    res.json(result);
  } catch (err) {
    console.error('[hiring/messages]', err);
    res.status(500).json({ error: err.message });
  }
});

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
