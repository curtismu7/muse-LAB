// Per-visitor workspaces (rule 13). Each browser gets its own id, cookie-bound. A full store refuses new visitors
// (create returns null, so the app answers 503 busy); it never evicts someone else's workspace.
import { createHash, randomBytes } from 'node:crypto';

const IDLE_MS = 30 * 60 * 1000;

export function createWorkspaces({ max = 200, idleMs = IDLE_MS, now = () => Date.now() } = {}) {
  const store = new Map();

  function sweep() {
    const t = now();
    for (const [id, ws] of store) {
      if (t - ws.touched > idleMs) store.delete(id);
    }
  }

  function create() {
    sweep();
    if (store.size >= max) return null;
    const id = randomBytes(16).toString('hex');
    // workspaceId is the public label of this workspace (for traces and the page). It is a hash: the id above is the session cookie and never leaves the server.
    const ws = { id, workspaceId: createHash('sha256').update(id).digest('hex').slice(0, 12), touched: now(), user: null, gatewayMode: 'mock', discovery: null, calls: [], decisions: [], holds: new Map(), tokens: {}, pending: {} };
    store.set(ws.id, ws);
    return ws;
  }

  function find(id) {
    sweep();
    const ws = id ? store.get(id) : undefined;
    if (!ws) return null;
    ws.touched = now();
    return ws;
  }

  return { create, find, size: () => store.size };
}
