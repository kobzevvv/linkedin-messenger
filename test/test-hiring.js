import { LinkedInMessenger } from '../src/index.js';

const m = new LinkedInMessenger({ cdpPort: 9224, timeout: 15000 });
await m.connect();

const JOB_ID = '4379775276';

console.log('=== Fetching applicants ===');
const applicants = await m.getHiringApplicants(JOB_ID, { limit: 5 });

for (const a of applicants) {
  const status = a.contacted ? `✓ Contacted ${a.contactedTime}` : '○ Not contacted';
  console.log(`${a.name} | ${a.title} | ${a.location} | ${status} | appId: ${a.applicationId}`);
}

// For contacted applicants, discover thread URLs
const contacted = applicants.filter(a => a.contacted);
console.log(`\n=== ${contacted.length} contacted applicants — discovering threads ===`);

for (const a of contacted) {
  console.log(`\nLooking up thread for ${a.name}...`);
  const result = await m.getApplicantThreadUrl(JOB_ID, a.applicationId);
  if (result) {
    console.log(`  Thread: ${result.threadUrl}`);
    // Read the conversation
    const thread = await m.getThread(result.threadUrl, { limit: 5 });
    console.log(`  Messages (${thread.messages.length}):`);
    for (const msg of thread.messages) {
      console.log(`    [${msg.from}] ${msg.text.substring(0, 100)}`);
    }
  } else {
    console.log('  No thread found');
  }
}

await m.disconnect();
