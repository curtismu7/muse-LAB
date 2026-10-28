import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, BaseEdge, EdgeLabelRenderer, getBezierPath, useNodesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { loadDiagram } from './diagrams/index.js';

// How Muse works, as two tabs: Config (set up once) and Runtime (what happens on a request).
// Standard: movable boxes, Simulate with Prev/Next/Pause, Reset, a speed control, every arrow numbered AND named, a card per step.
const STEP_MS = 1600;
const SPEEDS = [0.5, 1, 2];
const TABS = [{ id: 'muse-config', label: 'Config' }, { id: 'muse-runtime', label: 'Runtime' }];
const BOX_W = 230;

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
      <span className="hop-label"><strong>{data.label}</strong>{data.sub.map((l) => <small key={l}>{l}</small>)}</span>
    </>
  );
}
const Lane = ({ data }) => <span className="lane-title">{data.label}</span>;

// The number and the name read as one pill on the line.
function Pill({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={`mf-edge mf-${data.state}`} />
      <EdgeLabelRenderer>
        <span className={`pill pill-${data.state}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }} data-testid={`pill-${data.label}`}>
          <b>{data.label}</b> {data.name}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}
const nodeTypes = { box: Box, lane: Lane };
const edgeTypes = { pill: Pill };

function sides(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ['r', 'l'] : ['l', 'r']) : (dy > 0 ? ['b', 't'] : ['t', 'b']);
}

export default function MuseFlow() {
  const [tab, setTab] = useState(TABS[0].id);
  return (
    <section className="flow mflow" aria-label="How Muse works" data-testid="muse-flow">
      <div className="seg" role="tablist" aria-label="Diagram">
        {TABS.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      <Canvas key={tab} diagram={loadDiagram(tab)} />
    </section>
  );
}

function Canvas({ diagram: D }) {
  const colour = (n) => D.groups[n.group]?.color ?? 'grey';
  const byId = useMemo(() => Object.fromEntries(D.nodes.map((n) => [n.id, n])), [D]);
  const startNodes = useCallback(() => [
    ...D.lanes.map((l) => ({ id: l.id, type: 'lane', position: { x: l.x, y: l.y }, data: { label: l.label }, draggable: false, selectable: false, focusable: false, zIndex: -1, style: { width: l.w, height: l.h }, className: 'lane' })),
    ...D.nodes.map((n) => ({ id: n.id, type: 'box', position: { x: n.x, y: n.y }, data: { label: n.label, sub: n.sub ?? [] }, style: { width: BOX_W }, className: `hop grp-${colour(n)}` })),
  ], [D]);
  const [nodes, setNodes, onNodesChange] = useNodesState(startNodes());
  const [current, setCurrent] = useState(null); // null = not started; otherwise the step shown
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const LAST = D.steps.length - 1;
  const timer = useRef(null);

  const stop = () => { clearInterval(timer.current); setPlaying(false); };
  const play = (from) => {
    clearInterval(timer.current); setPlaying(true);
    let s = from; setCurrent(s);
    timer.current = setInterval(() => {
      if (s >= LAST) { stop(); return; }
      s += 1; setCurrent(s);
    }, STEP_MS / speed);
  };
  // A new speed takes effect from the next step.
  useEffect(() => { if (playing) play(current ?? 0); }, [speed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearInterval(timer.current), []);
  const reset = () => { stop(); setCurrent(null); setNodes(startNodes()); };
  const go = (s) => { stop(); setCurrent(Math.max(0, Math.min(LAST, s))); };

  const stepEdges = current == null ? null : D.steps[current].edges;
  const newest = stepEdges ? Math.max(...stepEdges) : null;
  const pos = Object.fromEntries(nodes.map((n) => [n.id, n.position]));
  const edges = D.edges.map((e, i) => {
    const [a, b] = sides(pos[e.source], pos[e.target]);
    const state = stepEdges == null ? 'idle' : i === newest ? 'active' : stepEdges.includes(i) ? 'done' : 'future';
    return { id: `e${i}`, type: 'pill', source: e.source, target: e.target, sourceHandle: `s-${a}`, targetHandle: `t-${b}`, animated: state === 'active', data: { label: e.label, name: e.name, state }, markerEnd: { type: 'arrowclosed' }, className: `mf-${state}` };
  });
  const shown = nodes.map((n) => {
    if (n.type !== 'box' || newest == null) return n;
    const ends = new Set(); const done = new Set();
    for (const i of stepEdges) { const e = D.edges[i]; (i === newest ? ends : done).add(e.source); (i === newest ? ends : done).add(e.target); }
    const st = ends.has(n.id) ? 'active' : done.has(n.id) ? 'done' : 'idle';
    return { ...n, className: `hop hop-${st} grp-${colour(byId[n.id])}` };
  });
  const step = current == null ? null : D.steps[current];
  const nm = (id) => byId[id].label;

  return (
    <>
      <div className="flow-top">
        <h3>{D.title}</h3>
        <div className="flow-actions">
          <select aria-label="Diagram speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
          </select>
          <button type="button" onClick={() => play(0)} disabled={playing}>Simulate</button>
          <button type="button" onClick={() => go((current ?? 0) - 1)} disabled={current == null || current === 0}>Prev</button>
          <button type="button" onClick={() => (playing ? stop() : current == null ? play(0) : go(current + 1))} disabled={current === LAST && !playing}>{playing ? 'Pause' : 'Next'}</button>
          <button type="button" onClick={reset}>Reset</button>
        </div>
      </div>
      <p className="small muted">{D.lede}</p>
      <div className="flow-canvas flow-canvas--xl">
        <ReactFlow nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodes={shown} edges={edges} onNodesChange={onNodesChange} nodesDraggable nodesConnectable={false} fitView fitViewOptions={{ padding: 0.04 }} minZoom={0.2} proOptions={{ hideAttribution: true }}>
          <Background gap={18} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="step-count small muted" data-testid="step-count">{current == null ? `Press Simulate to play ${D.steps.length} steps, or pick one below. Drag any box to rearrange.` : `Step ${current + 1} / ${D.steps.length}`}</p>
      <div className="chips" role="list" aria-label="Steps">
        {D.edges.map((e, i) => (
          <button key={e.label} type="button" role="listitem" className={`chip${current === i ? ' on' : ''}`} onClick={() => go(i)}>
            <b>{e.label}</b> {nm(e.source)} &rarr; {nm(e.target)} / {e.name}
          </button>
        ))}
      </div>
      {step && (
        <article className="step-card" data-testid="step-card">
          <h4><b>{D.edges[newest].label}</b> {step.title}</h4>
          <p>{step.what}</p>
          <p className="muted"><strong>Why:</strong> {step.why}</p>
        </article>
      )}
    </>
  );
}
