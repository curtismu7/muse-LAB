// Rule 24: every place Muse shows JSON goes through the shared JsonPane (Form | JSON toggle, important keys marked, full view).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { setJsonView } from '../components/JsonPane.jsx';
import RawStep from '../RawStep.jsx';
import UserLoginPanel from '../UserLoginPanel.jsx';
import BookFlight from '../BookFlight.jsx';

beforeEach(() => setJsonView('raw'));

const STEP = {
  n: 1,
  title: 'Call Agent Privilege with no token',
  request: { method: 'POST', url: 'https://gateway.example/mcp', body: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
  response: { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://gateway.example/.well-known/oauth-protected-resource/mcp"' }, body: { error: 'unauthorized' } },
};
const METADATA = { n: 2, request: { method: 'GET', url: 'https://gateway.example/.well-known/oauth-protected-resource/mcp' }, response: { status: 200, body: { resource: 'https://gateway.example/mcp', authorization_servers: ['https://login.example'] } } };

describe('a raw step (discovery and connect)', () => {
  it('keeps the request line, status line and headers as text and gives each JSON body its own pane with a Form | JSON toggle', () => {
    render(<RawStep step={STEP} testId="t" />);
    expect(screen.getByTestId('t-req-head').textContent).toBe('POST https://gateway.example/mcp');
    expect(screen.getByTestId('t-res-head').textContent).toBe('HTTP 401\nwww-authenticate: Bearer resource_metadata="https://gateway.example/.well-known/oauth-protected-resource/mcp"');
    for (const id of ['t-req-body', 't-res-body']) {
      const box = screen.getByTestId(`${id}-box`);
      expect([...box.querySelectorAll('.jsonbox__toggle button')].map((b) => b.textContent)).toEqual(['Form', 'JSON']);
    }
  });

  it('the JSON view is the body exactly as sent, coloured (numbers too), with this lab\'s keys marked', () => {
    render(<RawStep step={STEP} testId="t" />);
    const body = screen.getByTestId('t-req-body');
    expect(JSON.parse(body.textContent)).toEqual({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(body.querySelector('.jtok--number')?.textContent).toBe('1');
    expect([...body.querySelectorAll('.jtok--hot')].map((n) => n.textContent)).toContain('"method"');
    expect(JSON.parse(screen.getByTestId('t-res-body').textContent)).toEqual({ error: 'unauthorized' });
  });

  it('the Form view lays the body out as a form (a label and a value per field), the important keys tinted', () => {
    setJsonView('form');
    render(<RawStep step={METADATA} testId="m" />);
    const body = screen.getByTestId('m-res-body');
    expect(body.className).toContain('json--form');
    expect(within(body).getByText('resource')).toBeInTheDocument();
    expect(body.querySelectorAll('.jform__row[data-hot="true"]').length).toBe(2);
  });

  it('a step with no body (a GET) is plain text, and a step with no response shows only the request', () => {
    render(<RawStep step={{ n: 3, request: { method: 'GET', url: 'https://as.example/meta' } }} testId="s" />);
    expect(screen.getByTestId('s-req').textContent).toBe('GET https://as.example/meta');
    expect(screen.queryByTestId('s-res')).toBeNull();
  });
});

describe('Sam\'s own token (Real, no agent)', () => {
  const props = { api: vi.fn(), guarded: async (f) => f(), signInWith: vi.fn(), mfaOff: false };
  const live = { mode: 'live', live: { userLogin: true } };

  it('shows the claims in a JsonPane and says whether an act claim is present', () => {
    render(<UserLoginPanel {...props} session={{ ...live, userLogin: { claims: { sub: 'user-1', aud: ['https://gateway.example/mcp'], scope: 'openid' }, steps: [] } }} />);
    expect(screen.getByText('no act claim')).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('user-claims').textContent)).toEqual({ sub: 'user-1', aud: ['https://gateway.example/mcp'], scope: 'openid' });
    expect(screen.getByTestId('user-claims-box').querySelectorAll('.jsonbox__toggle button')).toHaveLength(2);
  });

  it('an act claim is reported', () => {
    render(<UserLoginPanel {...props} session={{ ...live, userLogin: { claims: { sub: 'user-1', act: { sub: 'agent' } }, steps: [] } }} />);
    expect(screen.getByText('act present')).toBeInTheDocument();
  });
});

describe('the booking trace', () => {
  const api = vi.fn(async (method, path) => {
    if (path === '/api/flights') return { rules: {}, ruleCards: [], members: [], flights: [] };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const hops = [
    { n: 1, from: 'Muse', to: 'Agent Gateway', title: 'Muse calls the gateway', summary: 's', state: 'ok', raw: { request: { jsonrpc: '2.0', method: 'tools/call' } } },
    { n: 3, from: 'Agent Gateway', to: 'PingOne Authorize', title: 'The gateway asks Authorize', summary: 's', state: 'ok', raw: { request: { attributes: { ToolName: 'flights.book', Amount: 620, AgentSpendLimit: 500 } } } },
  ];
  const booking = { status: 'denied', headline: 'x', subheading: null, lines: [], rulesDenied: [], chip: null, hops };
  const mount = () => render(<BookFlight api={api} busy={false} guarded={async (f) => f()} signInWith={vi.fn()} bookMock={vi.fn()} onReset={vi.fn()} session={{ mode: 'mock', member: 'standard', agentLimit: 500, booking, bookings: [] }} />);

  it('opening a hop shows its raw JSON in a JsonPane with a Form | JSON toggle, marked with Authorize\'s inputs', async () => {
    mount();
    const trace = await screen.findByTestId('booking-trace');
    fireEvent.click(within(trace).getByText('The gateway asks Authorize').closest('button'));
    expect(JSON.parse(screen.getByTestId('hop-3').textContent)).toEqual(hops[1].raw);
    expect([...screen.getByTestId('hop-3-box').querySelectorAll('.jsonbox__toggle button')].map((b) => b.textContent)).toEqual(['Form', 'JSON']);
    const hot = [...screen.getByTestId('hop-3').querySelectorAll('.jtok--hot')].map((n) => n.textContent);
    expect(hot).toEqual(expect.arrayContaining(['"ToolName"', '"Amount"', '"AgentSpendLimit"']));
  });

  it('the pane has no scroll cap in the lab\'s own stylesheet (full view)', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src', 'styles.css'), 'utf8');
    expect(css).not.toMatch(/\.bk-raw/);
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) => /(^|[\s,.>])(json|pre)\b/.test(sel));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, sel, body] of rules) expect(body, sel).not.toMatch(/max-height|overflow(-[xy])?\s*:\s*(auto|scroll)/);
  });
});
