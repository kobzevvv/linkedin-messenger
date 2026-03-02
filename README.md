# linkedin-messenger

Programmatic access to LinkedIn messaging — read inbox, get threads, send messages.

Connects to your running Chrome browser via [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) and automates the LinkedIn messaging UI with [Playwright](https://playwright.dev/). No API keys, no tokens — just your browser session.

## Why

LinkedIn doesn't offer a messaging API. If you're building recruiting automation, candidate outreach, or CRM integrations, you need to scrape the UI. This library gives you clean, typed methods instead of writing fragile selectors yourself.

## Prerequisites

1. **Node.js** 18+
2. **Chrome** launched with remote debugging enabled:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-linkedin"

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-linkedin"
```

3. **Log into LinkedIn** in that Chrome window (just once — the session persists in the user-data-dir)

## Install

```bash
npm install linkedin-messenger
```

Or clone and use directly:

```bash
git clone https://github.com/kobzevvv/linkedin-messenger.git
cd linkedin-messenger
npm install
```

## Quick Start

```js
import { LinkedInMessenger } from 'linkedin-messenger';

const messenger = new LinkedInMessenger({ cdpPort: 9222 });
await messenger.connect();

// Get latest conversations
const inbox = await messenger.getInbox({ limit: 5 });
console.log(inbox);

// Read a specific thread
const thread = await messenger.getThread(inbox[0].threadUrl, { limit: 20 });
console.log(thread.messages);

// Send a reply
await messenger.sendMessage(inbox[0].threadUrl, 'Thanks for your message!');

await messenger.disconnect();
```

## API

### `new LinkedInMessenger(opts?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cdpPort` | number | `9222` | Chrome DevTools Protocol port |
| `timeout` | number | `10000` | Default timeout for operations (ms) |

### `connect()`

Connect to the running Chrome instance. Must be called before any other method.

### `getInbox({ limit? })`

Returns recent conversations from the inbox.

```js
const conversations = await messenger.getInbox({ limit: 10 });
```

Each conversation:
```js
{
  name: "John Doe",
  threadUrl: "https://www.linkedin.com/messaging/thread/2-abc123==/",
  lastMessage: "Thanks for reaching out!",
  lastMessageTime: "Feb 28",        // or ISO datetime when available
  lastMessageFrom: "them",          // "them" | "me"
  isUnread: true,
  unreadCount: 3
}
```

> **Note:** `getInbox` clicks each conversation to resolve the `threadUrl` (LinkedIn doesn't expose thread IDs in the DOM). This marks conversations as read.

### `getUnread()`

Returns only unread conversations. Uses LinkedIn's built-in "Unread" filter.

```js
const unread = await messenger.getUnread();
```

Returns the same format as `getInbox`.

### `getThread(threadUrl, { limit? })`

Returns full message history for a conversation.

```js
const thread = await messenger.getThread(threadUrl, { limit: 50 });
```

Response:
```js
{
  name: "John Doe",
  profileUrl: "https://www.linkedin.com/in/johndoe",
  messages: [
    {
      from: "them",          // "them" | "me"
      senderName: "John Doe",
      text: "Hi! I saw your job posting...",
      timestamp: "Wednesday"  // or ISO datetime
    },
    {
      from: "me",
      senderName: "You",
      text: "Thanks for applying!",
      timestamp: "10:13 PM"
    }
  ]
}
```

You can pass either a full URL or just the thread ID:
```js
// Both work:
await messenger.getThread("https://www.linkedin.com/messaging/thread/2-abc123==/");
await messenger.getThread("2-abc123==");
```

### `sendMessage(threadUrl, text)`

Send a message in an existing conversation.

```js
await messenger.sendMessage(threadUrl, "Hello! Are you available for a quick chat?");
// → { ok: true }
```

### `markAsRead(threadUrl)`

Mark a conversation as read by opening it.

```js
await messenger.markAsRead(threadUrl);
// → { ok: true }
```

### `disconnect()`

Close the CDP connection. Always call this when done.

## Usage Guide

Here's a typical workflow for building a recruiting assistant or CRM integration on top of this library.

### What you need

- **This library** — handles LinkedIn messaging I/O
- **A database** (SQLite, Postgres, Redis — anything) — to track conversation state, which candidates you've contacted, what stage they're in
- **Your automation script** — the business logic that decides what to do

### Step 1: Poll for new messages

```js
// Run on a schedule (e.g., every 5 minutes)
const messenger = new LinkedInMessenger({ cdpPort: 9222 });
await messenger.connect();

const unread = await messenger.getUnread();

for (const conv of unread) {
  const thread = await messenger.getThread(conv.threadUrl, { limit: 10 });
  const latestMessage = thread.messages.at(-1);

  // Save to your database
  await db.saveMessage({
    threadUrl: conv.threadUrl,
    candidateName: conv.name,
    profileUrl: thread.profileUrl,
    message: latestMessage.text,
    from: latestMessage.from,
    receivedAt: new Date()
  });
}

await messenger.disconnect();
```

### Step 2: Process and respond

```js
// Your business logic decides what to reply
const pending = await db.getPendingReplies();

const messenger = new LinkedInMessenger({ cdpPort: 9222 });
await messenger.connect();

for (const item of pending) {
  const reply = await generateReply(item); // your AI, templates, etc.
  await messenger.sendMessage(item.threadUrl, reply);
  await db.markReplied(item.id);
}

await messenger.disconnect();
```

### Step 3: Track conversation state

A typical state machine for recruiting:

```
new_message → screening_questions_sent → answers_received →
  → qualified → interview_scheduled
  → not_qualified → rejection_sent
```

Your database tracks where each candidate is. The script reads new messages, updates state, and sends appropriate replies.

### Tips

- **Don't run multiple instances** — only one script should control the Chrome window at a time
- **Add delays between operations** — LinkedIn may rate-limit aggressive automation. The library already adds small delays, but keep your polling interval at 5+ minutes
- **Keep Chrome running** — the library connects to an existing browser. If Chrome closes, you need to restart it and log in again (the `--user-data-dir` preserves your session)
- **Handle errors** — LinkedIn's UI changes occasionally. Wrap calls in try/catch and log failures for debugging

## How it Works

1. You start Chrome with `--remote-debugging-port` and log into LinkedIn
2. The library connects to Chrome via CDP using Playwright
3. It navigates to `linkedin.com/messaging/` and interacts with the page DOM
4. Selectors are based on LinkedIn's current UI (CSS classes + ARIA attributes)
5. No reverse-engineering of LinkedIn's private API — just browser automation

## License

MIT
