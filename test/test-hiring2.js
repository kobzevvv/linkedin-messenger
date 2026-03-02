import { LinkedInMessenger } from '../src/index.js';

const m = new LinkedInMessenger({ cdpPort: 9224, timeout: 15000 });
await m.connect();

const JOB_ID = '4379775276';

console.log('=== Applicants + inbox match ===');
const results = await m.getHiringMessages(JOB_ID, { limit: 15, inboxDepth: 30 });

for (const a of results) {
  const thread = a.threadUrl
    ? `💬 [${a.lastMessageFrom}] ${a.lastMessage?.substring(0, 60)}`
    : '—';
  console.log(`${a.name} | ${a.title?.substring(0, 40)} | ${thread}`);
}

const withThreads = results.filter(a => a.threadUrl);
console.log(`\nMatched: ${withThreads.length} / ${results.length} applicants have threads in inbox`);

await m.disconnect();
