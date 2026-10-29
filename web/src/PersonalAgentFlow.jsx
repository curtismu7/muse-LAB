import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MarkerType, Position, useNodesState, useEdgesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { loadDiagram } from './diagrams/index.js';

// The diagram is data (diagram-studio/1). This component only draws it and plays its steps.
const DIAGRAM = loadDiagram('personal-agent-flow');
const STEP_MS = 800;
const SPEEDS = [0.5, 1, 2];

// Which step a request stops at, given the server's decision. Steps are listed in the diagram data.
export function stopStep(entry) {
  const last = DIAGRAM.steps.length - 1;
  if (!entry) return last;
  if (entry.detect?.some((s) => s.result === 'block')) return 5;
  if (entry.coarse?.result === 'deny') return 5;
  if (entry.fine?.result === 'deny' || entry.fine?.result === 'step_up') return 6;
  if (entry.outcome === 'held') return 6;
  return last;
}

function nodeLabel(n) {
  return (
    <span className="hop-label">
      <strong>{n.label}</strong>
      {(n.sub ?? []).map((line) => <small key={line}>{line}</small>)}
    </span>
  );
}

// The chain runs left to right, steps down, then right to left. Each box's way in and way out face its neighbours, so no edge loops round a box.
const byId = Object.fromEntries(DIAGRAM.nodes.map((n) => [n.id, n]));
const side = (from, to) => (to.y > from.y + 40 ? [Position.Bottom, Position.Top] : to.x >= from.x ? [Position.Right, Position.Left] : [Position.Left, Position.Right]);
const ends = {};
for (const e of DIAGRAM.edges) {
  const [out, inn] = side(byId[e.source], byId[e.target]);
  (ends[e.source] ??= {}).out = out;
  (ends[e.target] ??= {}).in = inn;
}

function initialNodes() {
  return DIAGRAM.nodes.map((n) => ({
    id: n.id,
    position: { x: n.x, y: n.y },
    data: { label: nodeLabel(n) },
    sourcePosition: ends[n.id]?.out ?? Position.Right,
    targetPosition: ends[n.id]?.in ?? Position.Left,
    className: `hop hop-idle grp-${DIAGRAM.groups[n.group]?.color ?? 'grey'}`,
  }));
}

function initialEdges() {
  return DIAGRAM.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.source,
    target: e.target,
    label: e.label,
    type: 'smoothstep',
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 4,
    markerEnd: { type: MarkerType.ArrowClosed },
    className: 'hop-edge',
  }));
}

// Box states after playing step `s` (0-based). Nodes on the newest edge are the active ones. At the stop step a
// blocked or held request marks its box with that outcome.
function nodeStates(s, stop, outcome, actor) {
  const reached = new Set();
  const newest = DIAGRAM.steps[s].edges;
  for (const i of newest) {
    reached.add(DIAGRAM.edges[i].source);
    reached.add(DIAGRAM.edges[i].target);
  }
  const last = DIAGRAM.edges[Math.max(...newest)].target;
  const states = {};
  for (const n of DIAGRAM.nodes) {
    if (!reached.has(n.id)) states[n.id] = 'idle';
    else states[n.id] = 'done';
  }
  if (s === stop) {
    states[last] = outcome === 'blocked' || outcome === 'held' ? outcome : 'done';
  } else {
    states[last] = 'active';
  }
  // A person's call does not wait for consent, so that box is shown as skipped once the flow reaches it.
  if (actor === 'human' && states.consent !== 'idle') states.consent = 'skipped';
  return states;
}

export default function PersonalAgentFlow({ lastEntry }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes());
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges());
  const [speed, setSpeed] = useState(1);
  const [running, setRunning] = useState(false);
  const [stop, setStop] = useState(DIAGRAM.steps.length - 1);
  const [current, setCurrent] = useState(DIAGRAM.steps.length - 1);
  const timer = useRef(null);

  const paint = useCallback((s, target, outcome, actor) => {
    const states = nodeStates(s, target, outcome, actor);
    setNodes((ns) => ns.map((n) => ({
      ...n,
      className: `hop hop-${states[n.id]} grp-${DIAGRAM.groups[DIAGRAM.nodes.find((d) => d.id === n.id).group]?.color ?? 'grey'}`,
    })));
    setCurrent(s);
  }, [setNodes]);

  const reset = useCallback(() => {
    clearInterval(timer.current);
    setRunning(false);
    setNodes(initialNodes());
    setEdges(initialEdges());
    setCurrent(DIAGRAM.steps.length - 1);
  }, [setNodes, setEdges]);

  function simulate() {
    reset();
    const target = stopStep(lastEntry);
    const outcome = lastEntry?.outcome ?? 'allowed';
    const actor = lastEntry?.actor ?? 'agent';
    setStop(target);
    setRunning(true);
    let s = 0;
    paint(0, target, outcome, actor);
    timer.current = setInterval(() => {
      if (s >= target) {
        clearInterval(timer.current);
        setRunning(false);
        return;
      }
      s += 1;
      paint(s, target, outcome, actor);
    }, STEP_MS / speed);
  }

  useEffect(() => () => clearInterval(timer.current), []);

  // A new decision replays on its own, so the diagram follows the conversation.
  useEffect(() => {
    if (lastEntry) simulate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEntry?.id ?? lastEntry?.at]);

  const legend = useMemo(() => {
    const step = DIAGRAM.steps[current];
    return step ? `${step.title}. ${step.what}` : '';
  }, [current]);

  return (
    <section className="flow" aria-label="Personal agent flow">
      <div className="flow-top">
        <h3>{DIAGRAM.title}</h3>
        <div className="flow-actions">
          <select aria-label="Speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
          </select>
          <button type="button" onClick={simulate} disabled={running}>Simulate</button>
          <button type="button" onClick={reset}>Reset</button>
        </div>
      </div>
      <div className="flow-canvas flow-canvas--two-row">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodesDraggable
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="small muted">{legend} Drag the boxes to rearrange them.</p>
    </section>
  );
}
