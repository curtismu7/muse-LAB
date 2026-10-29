// Stories are data (rule 10): vertical packs in stories.json, each with a cast and story text that uses {{cast.x}} tokens for the cast and a short
// list of runtime tokens ({{points}}, {{tier}}) that the page fills with the answer. A pack with an undefined token is refused when it loads,
// and the tests render every pack, so a typo fails the build instead of showing "{{cast.provder}}" on screen.
import { readFileSync } from 'node:fs';

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const DEFAULT_FILE = new URL('./stories.json', import.meta.url);

// Throws on anything malformed or any undefined token. Returns the data unchanged when it is sound.
export function validateStories(data) {
  const fail = (m) => { throw new Error(`stories: ${m}`); };
  if (!data || data.schema !== 'muse-stories/1') fail('schema must be muse-stories/1');
  const runtime = new Set(Array.isArray(data.runtimeTokens) ? data.runtimeTokens : []);
  const verticals = data.verticals && typeof data.verticals === 'object' ? data.verticals : fail('no verticals');
  const names = Object.keys(verticals);
  if (names.length < 3) fail('at least three vertical packs are needed');
  if (!verticals[data.default]) fail(`default vertical "${data.default}" is not a pack`);
  for (const [name, v] of Object.entries(verticals)) {
    if (!v || typeof v.label !== 'string' || !v.cast || !v.story) fail(`${name}: needs label, cast and story`);
    for (const [k, val] of Object.entries(v.cast)) if (typeof val !== 'string' || !val || /[<>]/.test(val)) fail(`${name}: cast.${k} must be plain text`);
    for (const [key, text] of Object.entries(v.story)) {
      if (typeof text !== 'string') fail(`${name}: story.${key} must be text`);
      for (const m of text.matchAll(TOKEN)) {
        const t = m[1];
        if (t.startsWith('cast.')) { if (!(t.slice(5) in v.cast)) fail(`${name}: story.${key} uses undefined token {{${t}}}`); }
        else if (!runtime.has(t)) fail(`${name}: story.${key} uses undefined token {{${t}}}`);
      }
    }
  }
  return data;
}

export function loadStories(file = DEFAULT_FILE) {
  return validateStories(JSON.parse(readFileSync(file, 'utf8')));
}

// A pack with its cast tokens filled in. Runtime tokens ({{points}}, {{tier}}) are left for the page.
export function renderStory(data, vertical) {
  const name = vertical ?? data.default;
  const v = data.verticals[name];
  if (!v) return null;
  const fill = (text) => text.replace(TOKEN, (all, t) => (t.startsWith('cast.') ? v.cast[t.slice(5)] : all));
  const story = Object.fromEntries(Object.entries(v.story).map(([k, text]) => [k, fill(text)]));
  return { vertical: name, label: v.label, cast: v.cast, ...story, verticals: Object.entries(data.verticals).map(([key, p]) => ({ key, label: p.label })) };
}
