// Diagrams are diagram-studio/1 data, loaded by id. Each app keeps its own copy (copy, never import across repos).
import personalAgentFlow from './personal-agent-flow.json';
import personalAgentPattern from './personal-agent-pattern.json';
import personalAgentPatternIg from './personal-agent-pattern-ig.json';
import museOverview from './muse-overview.json';
import museConfig from './muse-config.json';
import museRuntimeA from './muse-runtime-a.json';
import museRuntimeB from './muse-runtime-b.json';
import museRuntimeC from './muse-runtime-c.json';

const REGISTRY = {
  'personal-agent-flow': personalAgentFlow,
  'personal-agent-pattern': personalAgentPattern,
  'personal-agent-pattern-ig': personalAgentPatternIg,
  'muse-overview': museOverview,
  'muse-config': museConfig,
  'muse-runtime-a': museRuntimeA,
  'muse-runtime-b': museRuntimeB,
  'muse-runtime-c': museRuntimeC,
};

export function loadDiagram(id) {
  const d = REGISTRY[id];
  if (!d || d.schema !== 'diagram-studio/1') throw new Error(`no diagram named ${id}`);
  return d;
}
