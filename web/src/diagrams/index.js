// Diagrams are diagram-studio/1 data, loaded by id. Each app keeps its own copy (copy, never import across repos).
import personalAgentFlow from './personal-agent-flow.json';
import personalAgentPattern from './personal-agent-pattern.json';
import personalAgentPatternIg from './personal-agent-pattern-ig.json';
import museOverview from './muse-overview.json';
import museConfig from './muse-config.json';
import museRuntimeA from './muse-runtime-a.json';
import museRuntimeB from './muse-runtime-b.json';
import museRuntimeC from './muse-runtime-c.json';
import museRuntimeD from './muse-runtime-d.json';
import museRuntimeE from './muse-runtime-e.json';
import museRuntimeF from './muse-runtime-f.json';

const REGISTRY = {
  'personal-agent-flow': personalAgentFlow,
  'personal-agent-pattern': personalAgentPattern,
  'personal-agent-pattern-ig': personalAgentPatternIg,
  'muse-overview': museOverview,
  'muse-config': museConfig,
  'muse-runtime-a': museRuntimeA,
  'muse-runtime-b': museRuntimeB,
  'muse-runtime-c': museRuntimeC,
  'muse-runtime-d': museRuntimeD,
  'muse-runtime-e': museRuntimeE,
  'muse-runtime-f': museRuntimeF,
};

// The address a diagram names for this server is a {{origin}} token, filled in with the address the page is served from, so a copy run anywhere shows its own.
const origin = () => (typeof window !== 'undefined' && window.location?.origin) || 'https://muse.example';
export function loadDiagram(id) {
  const d = REGISTRY[id];
  if (!d || d.schema !== 'diagram-studio/1') throw new Error(`no diagram named ${id}`);
  const text = JSON.stringify(d);
  return text.includes('{{origin}}') ? JSON.parse(text.replaceAll('{{origin}}', origin())) : d;
}
