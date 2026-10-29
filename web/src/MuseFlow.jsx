import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, BaseEdge, EdgeLabelRenderer, getBezierPath, useNodesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { loadDiagram } from './diagrams/index.js';
import { useTextSize } from './TextSize.jsx';

// How Muse works, one tab per diagram: Config (set up once) and the Runtime paths (what happens on a request), one per client.
// Standard: movable boxes, Simulate with Prev/Next/Pause, Reset, a speed control, every arrow numbered AND named, a card per step.
const STEP_MS = 1600;
const SPEEDS = [0.5, 1, 2];
const TABS = [{ id: 'muse-overview', label: 'Overview' }, { id: 'muse-config', label: 'Config' }, { id: 'muse-runtime-a', label: 'Runtime A: Muse acts for Sam' }, { id: 'muse-runtime-b', label: 'Runtime B: Airline Connector' }, { id: 'muse-runtime-c', label: 'Runtime C: just a user' }, { id: 'muse-runtime-d', label: 'Runtime D: Claude' }, { id: 'muse-runtime-e', label: 'Runtime E: ChatGPT' }, { id: 'muse-runtime-f', label: 'Runtime F: Codex' }];
const BOX_W = 300;

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
  // A return arrow along the same row that would run behind the boxes in between loops under them instead.
  if (Math.abs(dy) < 40 && Math.abs(dx) > 600) return ['b', 'b'];
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ['r', 'l'] : ['l', 'r']) : (dy > 0 ? ['b', 't'] : ['t', 'b']);
}

export default function MuseFlow() {
  const [tab, setTab] = useState(TABS[0].id);
  const fs = useTextSize();
  return (
    <section className="flow mflow" aria-label="How Muse works" data-testid="muse-flow">
      <div className="seg" role="tablist" aria-label="Diagram">
        {TABS.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      <Canvas key={`${tab}-${fs}`} diagram={loadDiagram(tab)} fs={fs} />
    </section>
  );
}

function Canvas({ diagram: D, fs }) {
  const colour = (n) => D.groups[n.group]?.color ?? 'grey';
  const byId = useMemo(() => Object.fromEntries(D.nodes.map((n) => [n.id, n])), [D]);
  // Lay the boxes out at full size: in each lane they wrap, in reading order, into as many columns as the width allows (room between columns for
  // the arrow pills). The canvas is as tall as the content and the page scrolls, so text is never shrunk to fit.
  const lay = useMemo(() => {
    const PAD = 30, HEAD = 64 * fs, PITCH_Y = 200 * fs;
    const cw = Math.max(300, Math.min(window.innerWidth * 0.98, 1900) - 64);
    const bw = Math.min(BOX_W * fs, Math.max(180, cw - PAD * 2 - 24)); // narrow screens: boxes shrink so the page never scrolls sideways
    const PITCH_X = bw + 170;
    const cols = Math.max(1, Math.min(4, Math.floor((cw - PAD * 2 + 170) / PITCH_X)));
    const pos = {}, lanes = []; let y = 10;
    for (const l of [...D.lanes].sort((p, q) => p.y - q.y)) {
      const inLane = D.nodes.filter((n) => n.y >= l.y - 2 && n.y < l.y + l.h).sort((p, q) => p.y - q.y || p.x - q.x);
      // A short lane (four boxes or fewer) stays on one row when the boxes can narrow a little to fit: a simple left-to-right story reads best.
      const n = inLane.length, gapC = 150, fitW = Math.floor((cw - PAD * 2 - gapC * (n - 1)) / Math.max(1, n));
      const compact = n >= 2 && n <= 4 && fitW >= 210;
      const c = compact ? n : Math.min(cols, Math.max(1, n)), rows = Math.ceil(n / c);
      const bwL = compact ? Math.min(bw, fitW) : bw, pitchX = bwL + (compact ? gapC : 170);
      const h = HEAD + rows * PITCH_Y - (PITCH_Y - 150 * fs) + PAD;
      inLane.forEach((nd, i) => { pos[nd.id] = { x: 10 + PAD + (i % c) * pitchX, y: y + HEAD + Math.floor(i / c) * PITCH_Y, w: bwL }; });
      lanes.push({ id: l.id, label: l.label, x: 10, y, w: PAD * 2 + c * pitchX - (compact ? gapC : 170), h });
      y += h + 30;
    }
    return { pos, lanes, height: y + 10, bw };
  }, [D, fs]);
  const startNodes = useCallback(() => [
    ...lay.lanes.map((l) => ({ id: l.id, type: 'lane', position: { x: l.x, y: l.y }, data: { label: l.label }, draggable: false, selectable: false, focusable: false, zIndex: -1, style: { width: l.w, height: l.h }, className: 'lane' })),
    ...D.nodes.map((n) => ({ id: n.id, type: 'box', position: lay.pos[n.id] ? { x: lay.pos[n.id].x, y: lay.pos[n.id].y } : { x: n.x, y: n.y }, data: { label: n.label, sub: n.sub ?? [] }, style: { width: lay.pos[n.id]?.w ?? lay.bw }, className: `hop grp-${colour(n)}` })),
  ], [D, lay]); // eslint-disable-line react-hooks/exhaustive-deps
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
      <div className="flow-canvas" style={{ height: lay.height }}>
        <ReactFlow nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodes={shown} edges={edges} onNodesChange={onNodesChange} nodesDraggable nodesConnectable={false} defaultViewport={{ x: 0, y: 0, zoom: 1 }} zoomOnScroll={false} preventScrolling={false} minZoom={0.3} maxZoom={2} proOptions={{ hideAttribution: true }}>
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
