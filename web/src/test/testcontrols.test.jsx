import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BookFlight from '../BookFlight.jsx';

const FLIGHTS = { SH103: 480, SH104: 500, SH106: 620, SH107: 940, SH108: 750 };
const INFO = {
  rules: { agentLimit: 500, premiumThreshold: 750, premiumTiers: ['Premier Gold'], tierAttribute: 'airlineMemberTier', limitAttribute: 'agentSpendLimit', limitMin: 1, limitMax: 100000, tierSourceReal: 'x', tierSourceMock: 'y' },
  ruleCards: [{ id: 'agent_spend_limit', name: 'n', code: 'c1', owner: 'You', short: 'Your rule', line: 'No tickets bought by an AI agent over $500' }, { id: 'premium_only', name: 'n', code: 'c2', owner: 'The airline', short: 'Airline rule', line: 'Only premium members can book over $750' }],
  members: [{ key: 'standard', tier: 'Premier Silver' }, { key: 'premium', tier: 'Premier Gold' }, { key: 'none' }],
  flights: Object.entries(FLIGHTS).map(([id, fare]) => ({ id, route: 'A-B', fare })),
};

// A small fake server: just enough of /api/flights and /api/booking/tier for the card.
function fakeApi({ configured = true, needs = [], explanation = null, real = false } = {}) {
  const st = { member: 'standard', limit: null, posts: [] };
  const api = vi.fn(async (method, path, body) => {
    if (path === '/api/flights') return INFO;
    if (path === '/api/booking/tier' && method === 'GET') return { mode: real ? 'real' : 'mock', configured, needs, explanation, last: null };
    if (path === '/api/booking/tier' && method === 'POST') {
      st.posts.push(body);
      if (body.member) st.member = body.member;
      if (Object.hasOwn(body, 'limit')) st.limit = body.limit === 'default' ? null : body.limit;
      return { mode: 'mock' };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { api, st };
}
const session = (st) => ({ mode: 'mock', member: st.member, agentLimit: st.limit ?? 500, agentLimitIsDefault: st.limit === null, booking: null, bookings: [] });
const base = { busy: false, guarded: async (f) => f(), signInWith: vi.fn(), bookMock: vi.fn(), onReset: vi.fn() };

function mount(fake, sessionOver = {}) {
  let utils;
  const onTierChanged = vi.fn(async () => { utils.rerender(<BookFlight {...base} api={fake.api} session={{ ...session(fake.st), ...sessionOver }} onTierChanged={onTierChanged} />); });
  utils = render(<BookFlight {...base} api={fake.api} session={{ ...session(fake.st), ...sessionOver }} onTierChanged={onTierChanged} />);
  return utils;
}

describe('Test controls card (Mock)', () => {
  it('is called Test controls, shows tier and limit, and explains both fields in one sentence each', async () => {
    mount(fakeApi());
    const card = await screen.findByTestId('tier-card');
    expect(within(card).getByRole('heading', { name: 'Test controls' })).toBeInTheDocument();
    expect(within(card).getByTestId('tier-value')).toHaveTextContent('Premier Silver');
    expect(within(card).getByTestId('limit-value')).toHaveTextContent('default ($500)');
    expect(card).toHaveTextContent("The airline's rule: only premium members (Premier Gold) can book over $750.");
    expect(card).toHaveTextContent("This is the user's own cap, in dollars, for tickets bought by an AI agent.");
  });

  it('presets, Default and the tier buttons send exactly the body the server expects', async () => {
    const fake = fakeApi();
    mount(fake);
    await screen.findByTestId('tier-card');
    fireEvent.click(screen.getByTestId('limit-250'));
    await waitFor(() => expect(fake.st.posts).toEqual([{ limit: 250 }]));
    await waitFor(() => expect(screen.getByTestId('limit-value')).toHaveTextContent('$250'));
    expect(screen.getByTestId('limit-250')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('limit-500')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('limit-1000'));
    await waitFor(() => expect(fake.st.posts.at(-1)).toEqual({ limit: 1000 }));
    fireEvent.click(screen.getByTestId('limit-default'));
    await waitFor(() => expect(fake.st.posts.at(-1)).toEqual({ limit: 'default' }));
    await waitFor(() => expect(screen.getByTestId('limit-default')).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByTestId('tier-premium'));
    await waitFor(() => expect(fake.st.posts.at(-1)).toEqual({ member: 'premium' }));
    await waitFor(() => expect(screen.getByTestId('tier-value')).toHaveTextContent('Premier Gold'));
  });

  it('a custom amount is checked in the browser first; Enter and Apply both submit; a bad one posts nothing', async () => {
    const fake = fakeApi();
    mount(fake);
    const input = await screen.findByTestId('limit-input');
    for (const bad of ['12.5', '0', '-5', '1e3', ' 500', '+5', '1000000', 'abc']) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.click(screen.getByTestId('limit-apply'));
      expect(await screen.findByTestId('limit-error'), bad).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'true');
    }
    expect(fake.st.posts).toEqual([]);
    fireEvent.change(input, { target: { value: '750' } });
    expect(screen.queryByTestId('limit-error')).toBeNull();
    fireEvent.submit(input.closest('form'));
    await waitFor(() => expect(fake.st.posts).toEqual([{ limit: 750 }]));
    await waitFor(() => expect(screen.getByTestId('limit-value')).toHaveTextContent('$750'));
    expect(input).toHaveValue('');
  });

  it('the scenario table and the rule card follow the limit', async () => {
    const fake = fakeApi();
    fake.st.limit = 1000;
    mount(fake);
    await screen.findByTestId('tier-card');
    await waitFor(() => expect(screen.getByTestId('expect-3')).toHaveTextContent('Allowed past both rules'));
    expect(screen.getByTestId('expect-9')).toHaveTextContent('Denied by the airline rule');
    expect(screen.getByTestId('rule-line-agent_spend_limit')).toHaveTextContent('over $1000');
  });

  it('at the default limit the table reads as it always did', async () => {
    mount(fakeApi());
    await screen.findByTestId('tier-card');
    await waitFor(() => expect(screen.getByTestId('expect-3')).toHaveTextContent('Denied by your rule'));
    expect(screen.getByTestId('expect-10')).toHaveTextContent('Denied by the airline rule: no tier set is not premium');
    expect(screen.getByTestId('rule-line-agent_spend_limit')).toHaveTextContent('over $500');
  });
});

describe('Test controls card (Real, not configured)', () => {
  it('disables every control and names the variables, MUSE_TIER_ENABLE included', async () => {
    const fake = fakeApi({ real: true, configured: false, needs: ['MUSE_TIER_ENABLE', 'MUSE_TIER_WORKER_CLIENT_ID', 'MUSE_TIER_WORKER_CLIENT_SECRET', 'MUSE_TIER_USER_IDS'], explanation: 'The test controls are off on this build (MUSE_HOSTED=1). Set MUSE_TIER_ENABLE=1 in Muse\'s own .env to opt in.' });
    mount(fake, { mode: 'live' });
    const note = await screen.findByTestId('tier-unconfigured');
    for (const n of ['MUSE_TIER_ENABLE', 'MUSE_TIER_WORKER_CLIENT_ID', 'MUSE_TIER_USER_IDS']) expect(note).toHaveTextContent(n);
    for (const id of ['tier-premium', 'tier-standard', 'tier-none', 'limit-250', 'limit-500', 'limit-1000', 'limit-default', 'limit-input', 'limit-apply']) expect(screen.getByTestId(id), id).toBeDisabled();
    fireEvent.click(screen.getByTestId('limit-250'));
    expect(fake.st.posts).toEqual([]);
  });
});
