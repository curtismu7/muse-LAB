// Rule 25 on the Run page: Book a flight shows "What Privilege did" under the Run result, for the mode the page is in, and nothing before a result.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import BookFlight from '../BookFlight.jsx';
import { setJsonView } from '../components/JsonPane.jsx';

beforeEach(() => setJsonView('raw'));

const api = vi.fn(async (method, path) => {
  if (path === '/api/flights') return { rules: { agentLimit: 500, premiumThreshold: 750 }, ruleCards: [], members: [], flights: [] };
  if (path === '/api/booking/tier') return { mode: 'mock', configured: false, needs: [], readOnly: false };
  throw new Error(`unexpected ${method} ${path}`);
});
const base = { busy: false, guarded: async (f) => f(), signInWith: vi.fn(), bookMock: vi.fn(), onReset: vi.fn(), onTierChanged: vi.fn(), api };

const hop = { n: 1, from: 'Muse', to: 'Agent Gateway', title: 'Muse calls the gateway', summary: 's', state: 'ok', raw: {} };
const booking = (trace) => ({ status: 'denied', rulesDenied: [], lines: [], headline: 'Booking stopped', message: 'm', chip: null, hops: [hop], trace });
const mockTrace = {
  source: 'mock',
  request: { method: 'POST', url: 'https://gateway.mock.invalid/mcp', headers: { authorization: 'Bearer simulated-token' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'flights.book', arguments: { flightId: 'SH107' } } } },
  response: { status: 403, headers: {}, body: { error: 'access_denied' } },
  decisions: [{ id: 'agent_spend_limit', label: 'Your rule', outcome: 'fail', basis: 'checked', evidence: 'fare $940 is over your $500 limit' }],
  record: null,
};
const realTrace = { ...mockTrace, source: 'real', request: { ...mockTrace.request, url: 'https://gw.example/mcp' }, decisions: [{ id: 'authorize', label: 'PingOne Authorize', outcome: 'fail', basis: 'observed', evidence: 'the audit trail reports DENY' }] };
const session = (mode, b) => ({ mode, member: 'standard', agentLimit: 500, agentLimitIsDefault: true, booking: b, bookings: [], live: { userLogin: true } });

describe('Book a flight shows What Privilege did', () => {
  it('Mock: the panel appears under the result with the simulated decision and the request', async () => {
    render(<BookFlight {...base} session={session('mock', booking(mockTrace))} />);
    const panel = await screen.findByTestId('gateway-trace');
    expect(within(panel).getByRole('heading', { name: 'What Privilege did' })).toBeInTheDocument();
    expect(within(panel).getByTestId('gateway-trace-basis')).toHaveTextContent(/Simulated/);
    expect(within(panel).getByTestId('trace-1-decisions')).toHaveTextContent('fare $940 is over your $500 limit');
    expect(within(panel).getByTestId('trace-1-request-body')).toHaveTextContent('flights.book');
    // after the result, not before it
    expect(screen.getByTestId('booking-banner').compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Real: the panel says the gateway is real and marks the decision as observed', async () => {
    render(<BookFlight {...base} session={session('live', booking(realTrace))} />);
    const panel = await screen.findByTestId('gateway-trace');
    expect(within(panel).getByTestId('gateway-trace-basis')).toHaveTextContent(/Real gateway/);
    expect(within(panel).getByText('observed in the response')).toBeInTheDocument();
  });

  it('before any result there is no request or decision, only the empty state', async () => {
    render(<BookFlight {...base} session={session('mock', null)} />);
    const panel = await screen.findByTestId('gateway-trace');
    expect(within(panel).getByTestId('gateway-trace-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('trace-1')).toBeNull();
  });

  it("a trace from the other mode is never shown as this mode's call", async () => {
    render(<BookFlight {...base} session={session('live', booking(mockTrace))} />);
    const panel = await screen.findByTestId('gateway-trace');
    expect(within(panel).getByTestId('gateway-trace-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('trace-1')).toBeNull();
  });
});
