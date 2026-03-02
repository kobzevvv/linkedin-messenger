/**
 * Repair module — uses Claude Sonnet to fix broken selectors in linkedin-messenger.js.
 *
 * Reads the source file, sends it to Claude with DOM context from broken selectors,
 * and applies the returned string replacements.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOURCE_PATH = join(__dirname, 'linkedin-messenger.js');

/**
 * Build the prompt for Claude to fix broken selectors.
 */
function buildPrompt(sourceCode, brokenSelectors) {
  const brokenDetails = brokenSelectors.map((b, i) => {
    const ctx = b.domContext || {};
    return `
### Broken selector ${i + 1}: ${b.selector}
- **Description**: ${b.description}
- **Page**: ${b.page}
- **Related classes found on live page**: ${(ctx.relatedClasses || []).join(', ') || 'none'}
- **Sample elements on page**:
${(ctx.sampleElements || []).map(el =>
  `  <${el.tag} class="${el.classes}" role="${el.role}" aria-label="${el.ariaLabel}">`
).join('\n') || '  (none)'}
- **Container HTML snippet** (first 2KB of <main>):
\`\`\`html
${(ctx.containerHtml || '').substring(0, 2048)}
\`\`\`
`;
  }).join('\n');

  return `You are a Playwright selector repair tool for LinkedIn automation.

LinkedIn changed its HTML structure and the following selectors no longer match any elements on the live page. Your job is to figure out the new correct selectors by analyzing the DOM context captured from the live page, and return exact string replacements to fix the source code.

## Source file: linkedin-messenger.js

\`\`\`javascript
${sourceCode}
\`\`\`

## Broken selectors with DOM context from live page

${brokenDetails}

## Instructions

1. For each broken selector, look at the "related classes" and "sample elements" to find what LinkedIn renamed it to.
2. Return a JSON array of replacements. Each replacement is an object with \`oldString\` and \`newString\` — exact substrings of the source file to find-and-replace.
3. Be precise: \`oldString\` must appear exactly in the source. Include enough surrounding code to be unambiguous.
4. Only fix the broken selectors. Do not refactor or change anything else.
5. If you cannot determine the correct replacement for a selector, skip it (don't guess wildly).

Return ONLY a JSON array, no markdown fences, no explanation:
[{"oldString": "...", "newString": "..."}, ...]`;
}

/**
 * Repair broken selectors using Claude API.
 *
 * @param {object[]} brokenSelectors - Array from health-check with domContext
 * @param {object} opts
 * @param {function} opts.log - Logger
 * @returns {Promise<{ repaired: boolean, changes: object[] }>}
 */
export async function repairSelectors(brokenSelectors, { log = console.log } = {}) {
  if (!brokenSelectors.length) {
    log('[repair] No broken selectors to fix.');
    return { repaired: false, changes: [] };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log('[repair] ANTHROPIC_API_KEY not set — cannot auto-repair.');
    return { repaired: false, changes: [] };
  }

  log(`[repair] Reading source file: ${SOURCE_PATH}`);
  const sourceCode = readFileSync(SOURCE_PATH, 'utf-8');

  log(`[repair] Calling Claude Sonnet to fix ${brokenSelectors.length} broken selector(s)...`);
  const prompt = buildPrompt(sourceCode, brokenSelectors);

  const client = new Anthropic();
  let response;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    log(`[repair] Claude API error: ${err.message}`);
    return { repaired: false, changes: [] };
  }

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Parse JSON response — strip markdown fences if present
  let changes;
  try {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const cleaned = (fenceMatch ? fenceMatch[1] : text).trim();
    changes = JSON.parse(cleaned);
    if (!Array.isArray(changes)) throw new Error('Response is not an array');
  } catch (err) {
    log(`[repair] Failed to parse Claude response as JSON: ${err.message}`);
    log(`[repair] Raw response: ${text.substring(0, 500)}`);
    return { repaired: false, changes: [] };
  }

  // Validate and apply replacements
  let modified = sourceCode;
  const applied = [];

  for (const change of changes) {
    if (!change.oldString || !change.newString) {
      log(`[repair]   Skipping invalid change: missing oldString/newString`);
      continue;
    }
    if (change.oldString === change.newString) {
      log(`[repair]   Skipping no-op change: oldString === newString`);
      continue;
    }
    if (!modified.includes(change.oldString)) {
      log(`[repair]   Skipping change: oldString not found in source`);
      log(`[repair]     oldString: ${change.oldString.substring(0, 100)}`);
      continue;
    }

    modified = modified.replaceAll(change.oldString, change.newString);
    applied.push(change);
    log(`[repair]   Applied: "${change.oldString.substring(0, 60)}" → "${change.newString.substring(0, 60)}"`);
  }

  if (applied.length === 0) {
    log('[repair] No changes applied.');
    return { repaired: false, changes: [] };
  }

  // Write modified source
  writeFileSync(SOURCE_PATH, modified, 'utf-8');
  log(`[repair] Wrote ${applied.length} fix(es) to ${SOURCE_PATH}`);

  return { repaired: true, changes: applied };
}
