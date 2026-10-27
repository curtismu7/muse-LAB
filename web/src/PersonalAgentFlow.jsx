import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MarkerType, useNodesState, useEdgesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// The personal agent pattern, left to right. Each box is one hop a request takes.
const LAYOUT = [
  { id: 'user', label: 'User', sub: 'Sam signs in' },
  { id: 'muse', label: 'Muse', sub: 'Personal agent' },
  { id: 'detect', label: 'Muse-detect', sub: 'DaVinci flow (simulated)' },
  { id: 'coarse', label: 'Coarse check', sub: 'Who may call the tool' },
  { id: 'fine', label: 'Fine check', sub: 'Business rule for this call' },
  { id: 'resource', label: 'Resource', sub: 'The tool runs' },
];

const STEP_MS = 800;
const SPEEDS = [0.5, 1, 2];

// Where a request stops, given the server's decision. Blocked stops at the gate that blocked it.
export function stopIndex(entry) {
  if (!entry) return LAYOUT.length - 1;
  if (entry.detect?.some((s) => s.result === 'block')) return 2;
  if (entry.coarse?.result === 'deny') return 3;
  if (entry.fine?.result === 'deny') return 4;
  if (entry.outcome === 'held') return 4;
  return LAYOUT.length - 1;
}

function nodeLabel(n) {
  return (
    <span className="hop-label">
      <strong>{n.label}</strong>
      <small>{n.sub}</small>
    </span>
  );
}

function initialNodes() {
  return LAYOUT.map((n, i) => ({
    id: n.id,
    position: { x: i * 190, y: 40 },
    data: { label: nodeLabel(n) },
    className: 'hop hop-idle',
  }));
}

// Box state for a step: boxes before the current one are done, the current one is active,
// and the box where a request stopped shows its outcome (blocked or held).
function stateFor(i, step, target, outcome) {
  if (i < step) return 'done';
  if (i > step) return 'idle';
  if (step === target && outcome !== 'allowed' && outcome !== 'approved') return outcome;
  return step === target ? 'done' : 'active';
}

function initialEdges() {
  return LAYOUT.slice(1).map((n, i) => ({
    id: `e-${LAYOUT[i].id}-${n.id}`,
    source: LAYOUT[i].id,
    target: n.id,
    markerEnd: { type: MarkerType.ArrowClosed },
    className: 'hop-edge',
  }));
}

export default function PersonalAgentFlow({ lastEntry }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes());
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges());
  const [speed, setSpeed] = useState(1);
  const [running, setRunning] = useState(false);
  const [stop, setStop] = useState(LAYOUT.length - 1);
  const timer = useRef(null);

  const paint = useCallback((step, target, outcome) => {
    setNodes((ns) => ns.map((n, i) => ({ ...n, className: `hop hop-${stateFor(i, step, target, outcome)}` })));
  }, [setNodes]);

  const reset = useCallback(() => {
    clearInterval(timer.current);
    setRunning(false);
    setNodes(initialNodes());
    setEdges(initialEdges());
  }, [setNodes, setEdges]);

  function simulate() {
    reset();
    const target = stopIndex(lastEntry);
    const outcome = lastEntry?.outcome ?? 'allowed';
    setStop(target);
    setRunning(true);
    let step = 0;
    paint(0, target, outcome);
    timer.current = setInterval(() => {
      step += 1;
      paint(step, target, outcome);
      if (step >= target) {
        clearInterval(timer.current);
        setRunning(false);
      }
    }, STEP_MS / speed);
  }

  useEffect(() => () => clearInterval(timer.current), []);

  // A new decision replays on its own, so the diagram follows the conversation.
  useEffect(() => {
    if (lastEntry) simulate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEntry?.id ?? lastEntry?.at]);

  const legend = useMemo(() => (stop === 2 ? 'Stopped at Muse-detect' : stop === 3 ? 'Stopped at the coarse check' : stop === 4 ? 'Stopped at the fine check' : 'Reached the resource'), [stop]);

  return (
    <section className="flow" aria-label="Personal agent flow">
      <div className="flow-top">
        <h3>Personal agent flow</h3>
        <div className="flow-actions">
          <select aria-label="Speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
          </select>
          <button type="button" onClick={simulate} disabled={running}>Simulate</button>
          <button type="button" onClick={reset}>Reset</button>
        </div>
      </div>
      <div className="flow-canvas">
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
      <p className="small muted">{legend}. Drag the boxes to rearrange them.</p>
    </section>
  );
}
