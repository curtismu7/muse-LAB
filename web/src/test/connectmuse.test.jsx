import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ConnectMuseAi, { EXAMPLE_PROMPTS, buildPrompt } from '../ConnectMuseAi.jsx';

// Invented values only. The "server" is a stub api().
const INFO = {
  url: 'https://muse.example/mcp', clientId: 'airline-connector', tokenAuth: 'none (public client, PKCE S256)', scope: 'mcp',
  redirectUris: ['https://chat.agent.example/oauth/callback'], airline: 'SkyHigh', publicReachable: true,
  tools: ['loyalty_balance', 'get_loyalty_status', 'list_flights', 'book_flight'],
};
const RULES = { rules: { agentLimit: 500, premiumThreshold: 750, premiumTiers: ['Premier Gold'] }, flights: [] };
const fakeApi = (info = INFO, { fail = false } = {}) => vi.fn(async (method, path) => {
  if (path === '/api/connector/info') { if (fail) throw new Error('request failed (404)'); return info; }
  if (path === '/api/flights') return RULES;
  throw new Error(`unexpected ${method} ${path}`);
});
const real = { mode: 'live', connector: { url: 'https://muse.example/mcp' } };

afterEach(() => { vi.restoreAllMocks(); });

describe('Connect muse.ai card', () => {
  it('Mock: one line saying the connector is not enabled in this mode, and no request is made', () => {
    const api = fakeApi();
    render(<ConnectMuseAi session={{ mode: 'mock', connector: { url: 'x' } }} api={api} />);
    expect(screen.getByRole('heading', { name: 'Connect muse.ai' })).toBeInTheDocument();
    expect(screen.getByTestId('connect-muse-off')).toHaveTextContent('not enabled in Mock mode');
    expect(api).not.toHaveBeenCalled();
    expect(screen.queryByTestId('cm-url-value')).toBeNull();
  });

  it('Real without a connector: says so, no request', () => {
    const api = fakeApi();
    render(<ConnectMuseAi session={{ mode: 'live', connector: null }} api={api} />);
    expect(screen.getByTestId('connect-muse-off')).toHaveTextContent('not enabled on this build');
    expect(api).not.toHaveBeenCalled();
  });

  it('shows the URL, client ID, no client secret, PKCE S256, scope mcp and the redirect URI, each with a Copy button', async () => {
    render(<ConnectMuseAi session={real} api={fakeApi()} />);
    expect(await screen.findByTestId('cm-url-value')).toHaveTextContent('https://muse.example/mcp');
    expect(screen.getByTestId('cm-client-value')).toHaveTextContent('airline-connector');
    expect(screen.getByTestId('cm-secret-value')).toHaveTextContent('none');
    expect(screen.getByTestId('cm-pkce-value')).toHaveTextContent('S256');
    expect(screen.getByTestId('cm-scope-value')).toHaveTextContent('mcp');
    expect(screen.getByTestId('cm-redirect-0-value')).toHaveTextContent('https://chat.agent.example/oauth/callback');
    for (const id of ['cm-url', 'cm-client', 'cm-secret', 'cm-pkce', 'cm-scope', 'cm-redirect-0']) {
      const b = screen.getByTestId(`${id}-copy`);
      expect(b.tagName).toBe('BUTTON');
      expect(b).toHaveAccessibleName(/^Copy /);
    }
    expect(screen.getByText('Client secret')).toBeInTheDocument();
  });

  it('Copy writes the exact value to the clipboard and shows a visible "Copied" that goes away', async () => {
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
    render(<ConnectMuseAi session={real} api={fakeApi()} />);
    const btn = await screen.findByTestId('cm-url-copy');
    expect(screen.getByTestId('cm-url-copy-state')).not.toHaveClass('on');
    fireEvent.click(btn);
    await waitFor(() => expect(write).toHaveBeenCalledWith('https://muse.example/mcp'));
    await waitFor(() => expect(screen.getByTestId('cm-url-copy-state')).toHaveClass('on'));
    expect(screen.getByTestId('cm-url-copy-state')).toHaveTextContent('Copied');
    expect(screen.getByTestId('cm-url-copy-state')).toHaveAttribute('aria-live', 'polite');
  });

  it('keyboard: the Copy button is a real button that takes focus', async () => {
    render(<ConnectMuseAi session={real} api={fakeApi()} />);
    const btn = await screen.findByTestId('cm-url-copy');
    btn.focus();
    expect(btn).toHaveFocus();
    expect(btn).not.toHaveAttribute('tabindex', '-1');
  });

  it('a failed copy says so instead of "Copied"', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    document.execCommand = vi.fn(() => false);
    render(<ConnectMuseAi session={real} api={fakeApi()} />);
    fireEvent.click(await screen.findByTestId('cm-scope-copy'));
    await waitFor(() => expect(screen.getByTestId('cm-scope-copy-state')).toHaveTextContent('Copy failed'));
    expect(screen.getByTestId('cm-scope-copy-state')).not.toHaveTextContent('Copied');
  });

  it('warns that muse.ai cannot reach a local address, and shows no warning for a public one', async () => {
    const { unmount } = render(<ConnectMuseAi session={real} api={fakeApi({ ...INFO, url: 'http://127.0.0.1:5100/mcp', publicReachable: false })} />);
    const warn = await screen.findByTestId('connect-muse-warning');
    expect(warn).toHaveTextContent('muse.ai runs in the cloud and cannot reach this address. Use the hosted URL.');
    unmount();
    render(<ConnectMuseAi session={real} api={fakeApi()} />);
    await screen.findByTestId('cm-url-value');
    expect(screen.queryByTestId('connect-muse-warning')).toBeNull();
  });

  it('Step 1 is the prompt, filled with the real URL, the client ID and the airline name', async () => {
    render(<ConnectMuseAi session={real} api={fakeApi({ ...INFO, airline: 'Blue Yonder' })} />);
    const prompt = await screen.findByTestId('cm-prompt');
    expect(prompt.textContent).toBe('Set up an MCP connector for me. Name: Blue Yonder Airline Connector. URL: https://muse.example/mcp. It uses OAuth. If you can register yourself automatically, do that. If registration fails or asks for a client ID, use client ID airline-connector: it is a public client with no client secret, PKCE S256, scope mcp. When it sends me to PingOne to sign in I will sign in as the demo user. Once it is connected, list the tools you got.');
    expect(screen.getByTestId('cm-prompt-copy')).toHaveAccessibleName('Copy the prompt for muse.ai');
    expect(screen.getByRole('heading', { name: 'Step 1: ask muse.ai to add it' })).toBeInTheDocument();
  });

  it('buildPrompt: no static client means no client-ID sentence; the default airline name is SkyHigh', () => {
    const p = buildPrompt({ ...INFO, clientId: null, airline: '' });
    expect(p).toContain('Name: SkyHigh Airline Connector.');
    expect(p).not.toContain('client ID');
    expect(p).toContain('URL: https://muse.example/mcp.');
  });

  it('Steps 2 to 4: the sign-in, the four tools with the old-connector hint, and the copyable example prompts', async () => {
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
    render(<ConnectMuseAi session={real} api={fakeApi()} />);
    await screen.findByTestId('cm-prompt');
    expect(screen.getByRole('heading', { name: 'Step 2: sign in' })).toBeInTheDocument();
    expect(screen.getByText(/Allow the Airline Connector to act for you/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Step 3: check you have four tools' })).toBeInTheDocument();
    const tools = within(screen.getByRole('list', { name: 'Tools muse.ai should list' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(tools).toEqual(['loyalty_balance', 'get_loyalty_status', 'list_flights', 'book_flight']);
    expect(screen.getByTestId('cm-tools-note')).toHaveTextContent('only two');
    expect(screen.getByTestId('cm-tools-note')).toHaveTextContent('Remove it and add it again');
    expect(screen.getByRole('heading', { name: 'Step 4: try these prompts' })).toBeInTheDocument();
    expect(EXAMPLE_PROMPTS).toEqual(['Book me a flight to London for $620 tomorrow', 'Book me a flight to Denver for $450 tomorrow', 'Book me a flight to Denver tomorrow', 'Book me a flight to Seattle for $500 tomorrow', 'List the flights I can book', 'How many points do I have?']);
    EXAMPLE_PROMPTS.slice(0, 4).forEach((p) => { expect(p).toMatch(/ to \w+/); expect(p).toMatch(/ tomorrow$/); });
    EXAMPLE_PROMPTS.forEach((p, i) => expect(screen.getByTestId(`cm-example-${i}`)).toHaveTextContent(p));
    const outcomes = ['Blocked: over the $500 limit.', 'Booked at your $450, noting the airline lists $180.', "Booked at the airline's $180.", 'Booked: exactly at the limit.', 'Lists the flights and their prices.', 'Shows your points balance.'];
    outcomes.forEach((o, i) => expect(screen.getByTestId(`cm-example-outcome-${i}`)).toHaveTextContent(o));
    fireEvent.click(screen.getByTestId('cm-example-copy-1'));
    await waitFor(() => expect(write).toHaveBeenCalledWith('Book me a flight to Denver for $450 tomorrow'));
  });

  it('"How the prompts work": the seven points in plain words, with the limit and threshold from the server', async () => {
    render(<ConnectMuseAi session={real} api={fakeApi()} />);
    const how = await screen.findByTestId('cm-how');
    const items = within(how).getAllByRole('listitem');
    expect(items).toHaveLength(7);
    expect(items[0]).toHaveTextContent('the price you state is the price the rules judge');
    expect(items[1]).toHaveTextContent("the airline's own price for London is used");
    expect(items[2]).toHaveTextContent('your price wins');
    await waitFor(() => expect(items[3]).toHaveTextContent('default is $500'));
    expect(items[3]).toHaveTextContent('only premium members (Premier Gold) can book over $750');
    expect(items[3]).toHaveTextContent('Test controls');
    expect(items[4]).toHaveTextContent('Booked, with a confirmation number');
    expect(items[4]).toHaveTextContent('held for approval');
    expect(items[5]).toHaveTextContent("the rules judge the price the agent states. A real airline would price the ticket itself");
    expect(items[6]).toHaveTextContent("muse.ai's assistant asks for a destination and a day first, so include them");
    expect(items[6]).toHaveTextContent('The connector ignores the day and only needs a price or a destination');
    expect(items[6]).toHaveTextContent('using the SkyHigh connector');
  });

  it('no static client or redirect URI: says muse.ai registers itself, with no empty Copy buttons', async () => {
    render(<ConnectMuseAi session={real} api={fakeApi({ ...INFO, clientId: null, redirectUris: [] })} />);
    expect(await screen.findByTestId('cm-client-none')).toHaveTextContent('muse.ai registers itself');
    expect(screen.getByTestId('cm-redirect-none')).toBeInTheDocument();
    expect(screen.queryByTestId('cm-client-copy')).toBeNull();
    expect(screen.queryByTestId('cm-redirect-0-copy')).toBeNull();
  });

  it('a failed load says so', async () => {
    render(<ConnectMuseAi session={real} api={fakeApi(INFO, { fail: true })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the connection details');
  });

  it('uses theme tokens only: no hard-coded colors and no purple in the card styles', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    const block = css.slice(css.indexOf('Connect muse.ai card'));
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|purple|violet|magenta/i);
  });
});
