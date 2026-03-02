/**
 * Test script for LinkedIn Messenger read operations.
 *
 * Prerequisites:
 * - Chrome running with --remote-debugging-port=9224
 * - Logged into LinkedIn in that Chrome instance
 *
 * Usage:
 *   node test/test-read.js [getInbox|getUnread|getThread]
 */

import { LinkedInMessenger } from '../src/index.js';

const CDP_PORT = 9224; // personal Chrome profile

async function testGetInbox(messenger) {
  console.log('\n=== getInbox(limit: 10) ===\n');
  const conversations = await messenger.getInbox({ limit: 10 });

  for (const conv of conversations) {
    const unreadMark = conv.isUnread ? ` [UNREAD x${conv.unreadCount}]` : '';
    console.log(`${conv.name}${unreadMark}`);
    console.log(`  Last: ${conv.lastMessageFrom === 'me' ? 'You' : conv.name}: ${conv.lastMessage.substring(0, 80)}...`);
    console.log(`  Time: ${conv.lastMessageTime}`);
    console.log(`  Thread: ${conv.threadUrl}`);
    console.log('');
  }

  console.log(`Total: ${conversations.length} conversations`);
  return conversations;
}

async function testGetUnread(messenger) {
  console.log('\n=== getUnread() ===\n');
  const unread = await messenger.getUnread();

  for (const conv of unread) {
    console.log(`${conv.name} [${conv.unreadCount} unread]`);
    console.log(`  Last: ${conv.lastMessage.substring(0, 80)}...`);
    console.log('');
  }

  console.log(`Total: ${unread.length} unread conversations`);
  return unread;
}

async function testGetThread(messenger, threadUrl) {
  console.log('\n=== getThread() ===\n');

  if (!threadUrl) {
    // Get first conversation from inbox
    const inbox = await messenger.getInbox({ limit: 1 });
    if (!inbox.length) {
      console.log('No conversations found');
      return;
    }
    threadUrl = inbox[0].threadUrl;
    console.log(`Using first conversation: ${inbox[0].name}`);
    console.log(`Thread URL: ${threadUrl}\n`);
  }

  const thread = await messenger.getThread(threadUrl, { limit: 20 });
  console.log(`Thread with: ${thread.name}`);
  console.log(`Profile: ${thread.profileUrl}\n`);

  for (const msg of thread.messages) {
    const sender = msg.from === 'me' ? 'You' : msg.senderName;
    console.log(`[${msg.timestamp}] ${sender}:`);
    console.log(`  ${msg.text.substring(0, 120)}`);
    console.log('');
  }

  console.log(`Total: ${thread.messages.length} messages`);
  return thread;
}

// Main
const command = process.argv[2] || 'getInbox';
const threadUrl = process.argv[3];

const messenger = new LinkedInMessenger({ cdpPort: CDP_PORT });

try {
  console.log(`Connecting to Chrome on port ${CDP_PORT}...`);
  await messenger.connect();
  console.log('Connected!');

  switch (command) {
    case 'getInbox':
      await testGetInbox(messenger);
      break;
    case 'getUnread':
      await testGetUnread(messenger);
      break;
    case 'getThread':
      await testGetThread(messenger, threadUrl);
      break;
    default:
      console.log(`Unknown command: ${command}`);
      console.log('Usage: node test/test-read.js [getInbox|getUnread|getThread] [threadUrl]');
  }
} catch (err) {
  console.error('Error:', err.message);
  if (err.message.includes('ECONNREFUSED')) {
    console.error(`\nChrome is not running with remote debugging on port ${CDP_PORT}.`);
    console.error('Start it with: chrome --remote-debugging-port=9224');
  }
} finally {
  await messenger.disconnect();
}
