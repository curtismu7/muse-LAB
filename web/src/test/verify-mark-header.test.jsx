// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy that call
// reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import App from '../App.jsx';

// The /api/session shape the server sends (server/src/index.js), signed out, Mock.
const SESSION = {
  customer: { brandName: 'Personal Agent', agentName: 'Personal Agent' }, workspaceId: 'w1', protectMode: 'mock', signedIn: false, persona: null,
  picker: false, hosted: false, connector: null, pf: null, mode: 'mock', live: { available: false }, agent: { enabled: false }, discovery: null,
  liveAuth: { registered: false, signedIn: false, claims: null, steps: [], error: null, ask: null, answer: null },
  userLogin: null, assistant: null, personas: [], tools: [], decisions: [], held: [],
};
const mark = (status, label, extra = {}) => ({ status, label, note: '', updatedAt: '2026-11-15', source: 'shipped', ...extra });
function withShelf(shelf) {
  globalThis.fetch = vi.fn(async (url) => {
    const body = url === '/api/session' ? SESSION : url === '/api/info' ? { source: 'mock', realAvailable: false, realReason: 'x' } : url === '/api/shelf' ? shelf : {};
    return { ok: true, status: 200, json: async () => body };
  });
}
beforeEach(() => { window.history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('verification mark in the header', () => {
  it('shows this lab\'s own mark beside the Shelf link, and no other lab\'s', async () => {
    withShelf({ shelfUrl: 'http://shelf.example', demos: [{ id: 'other-lab', verification: mark('in-progress', 'In progress') }, { id: 'muse', verification: mark('verified', 'Verified', { note: 'Booked a flight on the mock' }) }] });
    const { container } = render(<App />);
    const bar = within(await vi.waitFor(() => { const h = container.querySelector('header.shell-bar'); expect(h).not.toBeNull(); return h; }));
    expect(await bar.findByText('Verified')).toBeInTheDocument();
    expect(await bar.findByRole('link', { name: 'Shelf' })).toBeInTheDocument();
    expect(bar.queryByText('In progress')).toBeNull();
    expect(container.querySelectorAll('.verify')).toHaveLength(1);
    expect(bar.getByText('Verified').closest('.verify')).toHaveAttribute('title', expect.stringContaining('Booked a flight on the mock'));
  });

  it('shows nothing when the lab is opened on its own port (its /api/shelf has no demos) or the shelf has no mark for it', async () => {
    for (const shelf of [{ shelfUrl: 'http://shelf.example' }, { shelfUrl: 'http://shelf.example', demos: [{ id: 'muse', verification: null }] }, { shelfUrl: 'http://shelf.example', demos: [{ id: 'muse', verification: mark('none', 'None') }] }]) {
      withShelf(shelf);
      const { container, unmount } = render(<App />);
      const bar = within(await vi.waitFor(() => { const h = container.querySelector('header.shell-bar'); expect(h).not.toBeNull(); return h; }));
      expect(await bar.findByRole('link', { name: 'Shelf' })).toBeInTheDocument(); // the shelf answered, and still no badge
      expect(container.querySelector('.verify')).toBeNull();
      unmount();
    }
  });

  it('the badge is rendered by App.jsx: without the line this test fails', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'App.jsx'), 'utf8');
    expect(src.match(/<VerifyMark id="muse"/g)).toHaveLength(1);
  });
});
