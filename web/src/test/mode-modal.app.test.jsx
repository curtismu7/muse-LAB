// The Real-or-mock modal (shared mode-modal, rule 2) replaces the simulation banner on every view. Each view's old facts are in its modal line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import App from '../App.jsx';
import Diagram from '../Diagram.jsx';
import ConnectorSignIn from '../ConnectorSignIn.jsx';

const SESSION = {
  customer: { brandName: 'Personal Agent', agentName: 'Personal Agent' }, workspaceId: 'w1', protectMode: 'mock', signedIn: false, persona: null,
  picker: false, hosted: false, connector: null, pf: null, mode: 'mock', live: { available: false }, agent: { enabled: false }, discovery: null,
  liveAuth: { registered: false, signedIn: false, claims: null, steps: [], error: null, ask: null, answer: null },
  userLogin: null, assistant: null, personas: [], tools: [], decisions: [], held: [],
};
const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
function serve(routes) { globalThis.fetch = vi.fn(async (url) => (url in routes ? routes[url]() : answer(200, {}))); }
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  serve({ '/api/session': () => answer(200, SESSION), '/api/info': () => answer(200, { source: 'mock', realAvailable: false, realReason: 'x' }) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the agent page', () => {
  it('opens on MOCK with the local-build line, and the old banner paragraph is gone', async () => {
    render(<App />);
    const modal = await screen.findByTestId('mode-modal');
    expect(modal.dataset.mode).toBe('mock');
    expect(modal.textContent).toMatch(/MOCK/);
    expect(modal.textContent).toMatch(/PingOne sign-in, the DaVinci detection flow and Privilege are stubs in this build, and no tenant is contacted/);
    expect(modal.textContent).toMatch(/This is the local mock build/);
    expect(document.querySelector('aside.banner')).toBeNull();
    expect(screen.queryByText(/^Simulated\. PingOne sign-in/)).toBeNull();
  });

  it('says it is the hosted, mock-only build when the server says hosted', async () => {
    serve({ '/api/session': () => answer(200, { ...SESSION, hosted: true }), '/api/info': () => answer(200, { source: 'mock' }) });
    render(<App />);
    expect((await screen.findByTestId('mode-modal')).textContent).toMatch(/This is the hosted, mock-only build/);
  });

  it('says REAL, who signs in and where the calls go, and that nothing is simulated, when the session is live', async () => {
    serve({ '/api/session': () => answer(200, { ...SESSION, mode: 'live', live: { available: true, origin: 'https://gw.example' } }), '/api/info': () => answer(200, { source: 'real', realAvailable: true }) });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('mode-modal').dataset.mode).toBe('real'));
    const t = screen.getByTestId('mode-modal').textContent;
    expect(t).toMatch(/REAL/);
    expect(t).toMatch(/PingOne signs the user in \(DaVinci, Protect, MFA on medium risk, consent\)/);
    expect(t).toMatch(/through the gateway at https:\/\/gw\.example/);
    expect(t).toMatch(/Nothing in this mode is simulated/);
  });

  it('Got it closes it, and it stays away after a remount in the same session', async () => {
    const { unmount } = render(<App />);
    fireEvent.click(await screen.findByTestId('mode-modal-ok'));
    expect(screen.queryByTestId('mode-modal')).toBeNull();
    unmount();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Personal Agent' });
    expect(screen.queryByTestId('mode-modal')).toBeNull();
  });

  it('Escape closes it', async () => {
    render(<App />);
    await screen.findByTestId('mode-modal');
    fireEvent.keyDown(screen.getByTestId('mode-modal-ok'), { key: 'Escape' });
    expect(screen.queryByTestId('mode-modal')).toBeNull();
  });

  it('while the session loads or cannot be read there is no modal (the mode is not known, so no guess)', async () => {
    serve({ '/api/session': () => answer(500, { error: 'down' }) });
    render(<App />);
    await screen.findByRole('alert');
    expect(screen.queryByTestId('mode-modal')).toBeNull();
  });
});

describe('/diagram', () => {
  it('keeps the old banner fact in its line, and its dismissal is its own (the agent page does not hide it)', async () => {
    sessionStorage.setItem('muse-mode-seen-mock', '1');
    render(<Diagram />);
    const modal = await screen.findByTestId('mode-modal');
    expect(modal.textContent).toMatch(/This page calls no PingOne tenant and no gateway, in either mode/);
    expect(document.querySelector('aside.banner')).toBeNull();
  });
});

describe('/connector/signin', () => {
  it('reads MOCK until /api/info answers, then REAL when it is Real', async () => {
    window.history.replaceState(null, '', '/connector/signin?flow=abc');
    let release;
    const held = new Promise((r) => { release = r; });
    serve({ '/api/info': async () => { await held; return answer(200, { source: 'real', realAvailable: true }); }, '/connector/signin/config?flow=abc': () => answer(404, { error: 'unknown_flow' }) });
    render(<ConnectorSignIn />);
    expect((await screen.findByTestId('mode-modal')).dataset.mode).toBe('mock');
    release();
    await waitFor(() => expect(screen.getByTestId('mode-modal').dataset.mode).toBe('real'));
    expect(screen.getByTestId('mode-modal').textContent).toMatch(/talks to your configured PingOne and gateway/);
  });
});
