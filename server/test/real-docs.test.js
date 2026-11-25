// The lab's Real setup is documented in the lab itself: no pointer to another project's notes, PRs, addresses or ports,
// and the setup page agrees with the code it describes (rule codes, thresholds, catalogue).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { PREMIUM_THRESHOLD, AGENT_LIMIT_DEFAULT, PREMIUM_TIERS, RULES, TIER_ATTRIBUTE, OPEN_FARE_FLIGHT, listFlights } from '../src/fares.js';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const DOCS = ['README.md', '.env.example', 'CLAUDE.md', 'docs/real-setup.md', 'docs/setup-agents.md', 'docs/talk-track.md'];

test('README, settings template and setup docs never point at AI-DEMO2 notes, PRs, scripts, addresses or ports', () => {
  for (const f of DOCS) {
    const t = read(f);
    assert.doesNotMatch(t, /AI-DEMO2|ai-demo2|airline-booking-rules-import|set-airline-member-tier|merge-airline-booking-rules/, `${f}: AI-DEMO2 reference`);
    assert.doesNotMatch(t, /:3036\b|:9031\b|api\.ping\.demo/, `${f}: AI-DEMO2 address or port`);
  }
});

test('the README and .env.example link the lab own Real setup page, and it exists and says UNVERIFIED', () => {
  assert.ok(existsSync(new URL('docs/real-setup.md', root)));
  assert.match(read('README.md'), /\]\(docs\/real-setup\.md\)/);
  assert.match(read('.env.example'), /docs\/real-setup\.md/);
  const doc = read('docs/real-setup.md');
  assert.match(doc, /\*\*UNVERIFIED\.\*\*/);
  assert.match(doc, /owner-run/i);
  assert.match(doc, /MUSE_LIVE_GATEWAY_URL/);
});

test('the Real setup page agrees with the code: rule codes, thresholds, tier attribute, open fare, catalogue', () => {
  const doc = read('docs/real-setup.md');
  for (const r of Object.values(RULES)) { assert.ok(doc.includes(r.code), r.code); assert.ok(doc.includes(r.name), r.name); }
  assert.ok(doc.includes(TIER_ATTRIBUTE));
  for (const t of PREMIUM_TIERS) assert.ok(doc.includes(t));
  assert.ok(doc.includes(String(PREMIUM_THRESHOLD)) && doc.includes(String(AGENT_LIMIT_DEFAULT)));
  assert.ok(doc.includes(OPEN_FARE_FLIGHT));
  const ids = listFlights().map((f) => f.id);
  assert.ok(doc.includes(ids[0]) && doc.includes(ids[ids.length - 1]), 'the catalogue range SH101 to SH109 is named');
  assert.match(doc, /X-Gw-Audit-Trail/);
  assert.match(doc, /x-internal-gateway-secret/);
  assert.match(doc, /X-Hitl-Preapproved: user-limit/);
});

test('the setup page uses placeholders only: no real hosts, no tenant-looking ids', () => {
  const doc = read('docs/real-setup.md');
  assert.doesNotMatch(doc, new RegExp(`${['ping', 'devops'].join('-')}|pingidentity\\.com|auth\\.pingone\\.com/[0-9a-f]{8}`));
  assert.doesNotMatch(doc, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
});
