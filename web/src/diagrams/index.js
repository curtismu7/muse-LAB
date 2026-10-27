// Diagrams are diagram-studio/1 data, loaded by id. Each app keeps its own copy (copy, never import across repos).
import personalAgentFlow from './personal-agent-flow.json';
import personalAgentPattern from './personal-agent-pattern.json';

const REGISTRY = {
  'personal-agent-flow': personalAgentFlow,
  'personal-agent-pattern': personalAgentPattern,
};

export function loadDiagram(id) {
  const d = REGISTRY[id];
  if (!d || d.schema !== 'diagram-studio/1') throw new Error(`no diagram named ${id}`);
  return d;
}
