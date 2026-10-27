import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, MarkerType, Position, useNodesState, useEdgesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { loadDiagram } from './diagrams/index.js';

// The personal agent pattern: static story, no server decision. Data is diagram-studio/1; this draws it and plays its steps.
const STEP_MS = 800;
const SPEEDS = [0.5, 1, 2];

// A box with a handle on each side, so an arrow can leave toward its target (the default box only has top and bottom).
const SIDES = [['t', Position.Top], ['b', Position.Bottom], ['l', Position.Left], ['r', Position.Right]];
function Box({ data }) {
  return (
    <>
      {SIDES.map(([k, pos]) => (
        <span key={k}>
          <Handle id={`s-${k}`} type="source" position={pos} style={{ opacity: 0 }} />
          <Handle id={`t-${k}`} type="target" position={pos} style={{ opacity: 0 }} />
        </span>
      ))}
      {data.label}
    </>
  );
}
const nodeTypes = { box: Box };
function sides(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ['r', 'l'] : ['l', 'r']) : (dy > 0 ? ['b', 't'] : ['t', 'b']);
}

const label = (n) => (
  <span className="hop-label">
    <strong>{n.label}</strong>
    {(n.sub ?? []).map((line) => <small key={line}>{line}</small>)}
  </span>
);
const helpers = (DIAGRAM) => {
const colour = (n) => DIAGRAM.groups[n.group]?.color ?? 'grey';
const byId = Object.fromEntries(DIAGRAM.nodes.map((n) => [n.id, n]));
const startNodes = () => DIAGRAM.nodes.map((n) => ({ id: n.id, type: 'box', position: { x: n.x, y: n.y }, data: { label: label(n) }, className: `hop hop-idle grp-${colour(n)}` }));
const startEdges = () => DIAGRAM.edges.map((e, i) => { const [a, b] = sides(byId[e.source], byId[e.target]); return { id: `e${i}`, source: e.source, target: e.target, sourceHandle: `s-${a}`, targetHandle: `t-${b}`, label: e.label, markerEnd: { type: MarkerType.ArrowClosed }, className: 'hop-edge' }; });

// After playing step s, the boxes on the newest arrow are active and the boxes on earlier arrows are done.
function states(s) {
  const edges = DIAGRAM.steps[s].edges;
  const newest = DIAGRAM.edges[Math.max(...edges)];
  const out = Object.fromEntries(DIAGRAM.nodes.map((n) => [n.id, 'idle']));
  for (const i of edges) { out[DIAGRAM.edges[i].source] = 'done'; out[DIAGRAM.edges[i].target] = 'done'; }
  out[newest.source] = 'active'; out[newest.target] = 'active';
  return out;
}

  return { colour, startNodes, startEdges, states, LAST: DIAGRAM.steps.length - 1 };
};

const PATHS = [
  { id: 'personal-agent-pattern', label: 'Agent Privilege' },
  { id: 'personal-agent-pattern-ig', label: 'Agent Gateway (IG)' },
];

// Pick which product is the MCP gateway; each path is its own diagram, so the canvas restarts when it changes.
export default function PatternFlow() {
  const [path, setPath] = useState(PATHS[0].id);
  return <PatternCanvas key={path} diagram={loadDiagram(path)} path={path} setPath={setPath} />;
}

function PatternCanvas({ diagram: DIAGRAM, path, setPath }) {
  const { colour, startNodes, startEdges, states, LAST } = useMemo(() => helpers(DIAGRAM), [DIAGRAM]);
  const [nodes, setNodes, onNodesChange] = useNodesState(startNodes());
  const [edges, , onEdgesChange] = useEdgesState(startEdges());
  const [speed, setSpeed] = useState(1);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState(LAST);
  const timer = useRef(null);

  const paint = useCallback((s) => {
    const st = states(s);
    setNodes((ns) => ns.map((n) => ({ ...n, className: `hop hop-${st[n.id]} grp-${colour(DIAGRAM.nodes.find((d) => d.id === n.id))}` })));
    setCurrent(s);
  }, [setNodes]);

  // Reset restores box positions and styles too.
  const reset = useCallback(() => { clearInterval(timer.current); setRunning(false); setNodes(startNodes()); setCurrent(LAST); }, [setNodes]);

  function simulate() {
    reset();
    setRunning(true);
    let s = 0;
    paint(0);
    timer.current = setInterval(() => {
      if (s >= LAST) { clearInterval(timer.current); setRunning(false); return; }
      s += 1;
      paint(s);
    }, STEP_MS / speed);
  }
  useEffect(() => () => clearInterval(timer.current), []);

  const step = DIAGRAM.steps[current];
  return (
    <section className="flow" aria-label="Personal agent pattern" data-testid="pattern-flow">
      <div className="flow-top">
        <h3>{DIAGRAM.title}</h3>
        <div className="flow-actions">
          <div className="seg" role="group" aria-label="MCP gateway path">
            {PATHS.map((o) => <button key={o.id} type="button" aria-pressed={path === o.id} onClick={() => setPath(o.id)}>{o.label}</button>)}
          </div>
          <select aria-label="Pattern speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
          </select>
          <button type="button" onClick={simulate} disabled={running}>Simulate</button>
          <button type="button" onClick={reset}>Reset</button>
        </div>
      </div>
      <p className="small muted">{DIAGRAM.lede}</p>
      <div className="flow-canvas flow-canvas--tall">
        <ReactFlow nodeTypes={nodeTypes} nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} nodesDraggable nodesConnectable={false} fitView fitViewOptions={{ padding: 0.1 }} proOptions={{ hideAttribution: true }}>
          <Background gap={18} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="small muted" data-testid="pattern-legend">{step.title}. {step.what} Drag the boxes to rearrange them.</p>
    </section>
  );
}
