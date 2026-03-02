import { LinkedInMessenger } from '../src/index.js';

const m = new LinkedInMessenger({ cdpPort: 9224, timeout: 15000 });
await m.connect();

const inbox = await m.getInbox({ limit: 20 });

const italianNames = ['Pellegrino', 'Luis Carlos', 'Giuseppe', 'Chiariello', 'Colistra', 'Capone', 'De Lima'];
console.log('=== Checking inbox for Italian candidates ===');
let found = false;
for (const c of inbox) {
  const isItalian = italianNames.some(n => c.name.includes(n));
  if (isItalian) {
    console.log('FOUND: ' + c.name + ' | ' + c.lastMessage.substring(0, 100));
    found = true;
  }
}
if (found === false) console.log('No Italian candidates in messaging inbox yet.');

console.log('');
console.log('=== Candidates waiting for response ===');
const waiting = inbox.filter(c => c.lastMessageFrom === 'them');
for (const c of waiting) {
  console.log(c.name + ' | ' + c.lastMessageTime + ' | ' + c.lastMessage.substring(0, 80));
}
console.log('Total waiting:', waiting.length);

await m.disconnect();
