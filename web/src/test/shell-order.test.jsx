// Page order in every view the bundle renders (STANDALONE-UI-PATTERNS section 1): the shell bar first, then ONE <main> whose first child is the
// hand-off strip (when there is one), then the view and the "What Privilege did" trace; the Real-or-mock modal follows <main>. One <h1> and one <main> per view.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
function serve(routes) {
  globalThis.fetch = vi.fn(async (url) => (url in routes ? routes[url]() : answer(200, {})));
}
// The diagram (React Flow) needs ResizeObserver, which jsdom does not have.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
beforeEach(() => { window.history.replaceState(null, '', '/'); serve({ '/api/session': () => answer(200, SESSION), '/api/info': () => answer(200, { source: 'mock', realAvailable: false, realReason: 'x' }) }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Bar, then main with no simulation banner in it; one main and one h1 in the whole view. The modal (when the mode is known) comes after main.
function expectOrder(container, { h1 = 1 } = {}) {
  const bar = container.firstElementChild;
  expect(bar.matches('header.shell-bar')).toBe(true);
  const main = bar.nextElementSibling;
  expect(main.tagName).toBe('MAIN');
  expect(main.classList.contains('page')).toBe(true);
  expect(container.querySelector('aside.banner')).toBeNull();
  expect(container.querySelectorAll('main')).toHaveLength(1);
  expect(container.querySelectorAll('h1')).toHaveLength(h1);
  expect(bar.querySelector('h1')).toBeNull();
  return main;
}

describe('page order: shell bar, then main, then the Real-or-mock modal', () => {
  it('the app, signed out, Mock: the modal says MOCK after main, and the trace panel is in main', async () => {
    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Personal Agent' });
    const main = expectOrder(container);
    const modal = screen.getByTestId('mode-modal');
    expect(modal.dataset.mode).toBe('mock');
    expect(main.compareDocumentPosition(modal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main.contains(modal)).toBe(false);
    const trace = await screen.findByTestId('gateway-trace');
    expect(main.contains(trace)).toBe(true);
    expect(container.querySelector('.shell-badge').textContent).toBe('Mock');
  });

  it('the app with the hand-off strip: bar, strip first in main, then the page', async () => {
    window.history.replaceState(null, '', '/?from=customer-agent&uc=UC48');
    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Personal Agent' });
    const main = expectOrder(container);
    expect(main.children[0].matches('[role="note"].return-link--strip')).toBe(true);
  });

  it('the app while loading: the same order, no h1 yet', () => {
    serve({ '/api/session': () => new Promise(() => {}) });
    const { container } = render(<App />);
    expectOrder(container, { h1: 0 });
    expect(container.querySelector('main [role="status"]')).not.toBeNull();
    expect(screen.queryByTestId('mode-modal')).toBeNull(); // the mode is not known yet: no guess
  });

  it('the app when the server cannot be reached: the alert is in main and there is no modal', async () => {
    serve({ '/api/session': () => answer(500, { error: 'down' }) });
    const { container } = render(<App />);
    await screen.findByRole('alert');
    const main = expectOrder(container, { h1: 0 });
    expect(main.querySelector('[role="alert"]').textContent).toBe('down');
    expect(screen.queryByTestId('mode-modal')).toBeNull();
  });

  it('/diagram: bar, then the title and the diagram, with its own modal line', async () => {
    window.history.replaceState(null, '', '/diagram');
    const { container } = render(<Diagram />);
    const main = expectOrder(container);
    expect(main.querySelector('h1').textContent).toBe('How Personal Agent works');
    expect(container.querySelector('header.shell-bar a[href="/diagram"]').getAttribute('aria-current')).toBe('page');
    await vi.waitFor(() => expect(container.querySelector('.shell-badge')?.textContent).toBe('Mock'));
  });

  it('/connector/signin: bar, then the sign-in heading, also when the flow cannot be read', async () => {
    window.history.replaceState(null, '', '/connector/signin?flow=abc');
    serve({ '/api/info': () => answer(200, { source: 'real', realAvailable: true }), '/connector/signin/config?flow=abc': () => answer(404, { error: 'unknown_flow' }) });
    const { container } = render(<ConnectorSignIn />);
    await screen.findByRole('alert');
    const main = expectOrder(container);
    expect(main.querySelector('h1').textContent).toBe('Sign in');
    expect(main.querySelector('[role="alert"]').textContent).toBe('unknown_flow');
    await vi.waitFor(() => expect(screen.getByTestId('mode-modal').dataset.mode).toBe('real'));
    expect(screen.getByTestId('mode-modal').textContent).toMatch(/Nothing in this mode is simulated/);
    expect(container.querySelector('.shell-badge').textContent).toBe('Real');
  });
});
