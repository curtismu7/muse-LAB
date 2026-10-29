// customer.config (rule 12): branding and vocabulary in one small file. brandName is what the site calls itself (page title, band), agentName is the
// personal agent inside the story, tagline is the one-line summary, vertical picks the default story pack. MUSE_CUSTOMER_CONFIG points at another file.
// Every value is plain text, length-bounded, and anything unusable falls back to the shipped default, so a bad file can never break the page.
import { readFileSync } from 'node:fs';

const DEFAULT_FILE = new URL('./customer.config.json', import.meta.url);
const FIELDS = { brandName: 40, agentName: 40, tagline: 120, vertical: 20 };
const FALLBACK = { brandName: 'Agent Connect', agentName: 'Muse', tagline: '', vertical: 'airline' };

const clean = (v, max) => (typeof v === 'string' && v.trim() && !/[<>]/.test(v) ? v.trim().slice(0, max) : null);

export function loadCustomer(env = process.env, verticals = ['airline']) {
  let raw = {};
  for (const file of [env.MUSE_CUSTOMER_CONFIG, DEFAULT_FILE].filter(Boolean)) {
    try { raw = JSON.parse(readFileSync(file, 'utf8')); break; } catch { /* try the next, then the fallback */ }
  }
  const out = {};
  for (const [k, max] of Object.entries(FIELDS)) out[k] = clean(raw?.[k], max) ?? FALLBACK[k];
  if (!verticals.includes(out.vertical)) out.vertical = verticals[0] ?? FALLBACK.vertical;
  return out;
}
