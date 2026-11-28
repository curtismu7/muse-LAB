import { useEffect, useState } from 'react';
import TopMenu from './top-menu/TopMenu.jsx';
import ShelfLink from './components/ShelfLink.jsx';
import VerifyMark from './components/VerifyMark.jsx';
import ReturnLink from './return-link/ReturnLink.jsx';
import ModeModal from './mode-modal/ModeModal.jsx';
import { applyTheme, readTheme } from './ThemeToggle.jsx';
import { applySize, readSize, saveSize } from './textsize.js';

// The one frame every view of the bundle renders in (STANDALONE-UI-PATTERNS section 1): the shell bar first, then ONE <main class="page">
// in the centred frame whose first child is the hand-off strip (when there is one), then the view; the Real-or-mock modal (shared mode-modal) sits
// after <main>, so a view never remounts it. Page order is pinned by
// web/src/test/shell-order.test.jsx. The view supplies its own <h1>; the bar's brand is not a heading.

const FS_STEPS = { S: 0.85, M: 1, L: 1.15 };
const fsToStep = (v) => (v < 1 ? 'S' : v > 1 ? 'L' : 'M');
const LAB_REPO = 'https://github.com/curtismu7/muse-LAB#readme';

// Views that have no session of their own (the diagram, the connector sign-in page) read the mode from /api/info (a plain GET).
function useFetchedMode(enabled) {
  const [source, setSource] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    fetch('/api/info').then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d) setSource(d.source === 'real' ? 'real' : 'mock'); }).catch(() => {});
    return () => { alive = false; };
  }, [enabled]);
  return source;
}

// What the Real-or-mock modal says when a view gives no lines of its own (the connector sign-in page). Replaces the plain mode banner.
const DEFAULT_MODE_LINES = {
  mock: 'No PingOne tenant and no gateway is contacted in this build.',
  real: 'This page talks to your configured PingOne and gateway. Nothing in this mode is simulated.',
};

/**
 * mode: 'mock' | 'real' | null (no badge, no lookup) | undefined (look it up). menu: the TopMenu props only the view knows
 * (mode switch, presenter, reset, version). modeLines: the view's own { mock, real } line for the modal; modeKey: its sessionStorage prefix (one per view,
 * so dismissing it on one view does not hide another view's line). A null mode shows no modal; an unknown one (still being looked up) reads as MOCK.
 */
// The one <h1> every view renders (the page title); the bar's brand is not a heading.
export function PageTitle({ children, className }) {
  return <h1 className={className}>{children}</h1>;
}

export default function Frame({ brand = 'Personal Agent', mode, current = null, menu = {}, modeLines = DEFAULT_MODE_LINES, modeKey = 'muse-page-mode', strip = true, mainClass = '', children }) {
  const fetched = useFetchedMode(mode === undefined);
  const shownMode = mode === undefined ? fetched : mode;
  const [theme, setTheme] = useState(readTheme);
  const [size, setSize] = useState(() => fsToStep(readSize()));
  const pickTheme = (t) => {
    applyTheme(t);
    try { if (t === 'auto') window.localStorage.removeItem('muse.theme'); else window.localStorage.setItem('muse.theme', t); } catch { /* storage unavailable */ }
    setTheme(t);
  };
  const pickFontSize = (step) => { const v = FS_STEPS[step] ?? 1; saveSize(v); applySize(v); setSize(step); };
  return (
    <>
      <header className="shell-bar">
        <span className="shell-brand">
          <span className="shell-logo" aria-hidden="true">M</span> {brand}
          {shownMode && <span className="shell-badge">{shownMode === 'real' ? 'Real' : 'Mock'}</span>}
        </span>
        <nav className="shell-nav" aria-label="Site">
          <a href={current === 'agent' ? './' : '/'} aria-current={current === 'agent' ? 'page' : undefined}>Agent</a>
          <a href="/how-agent-connect-works.html">How it works</a>
          <a href="/how-agent-connect-works.html#connect">How customers connect</a>
          <a href="/clients.html">Claude, ChatGPT, Codex</a>
          <a href="/diagram" aria-current={current === 'diagram' ? 'page' : undefined}>Diagram</a>
        </nav>
        <TopMenu
          theme={{ value: theme, onChange: pickTheme }}
          fontSize={{ value: size, onChange: pickFontSize }}
          help={{ href: LAB_REPO }}
          {...menu}
        >
          <ShelfLink />
          <VerifyMark id="muse" />
          <ReturnLink app="muse" variant="header" />
        </TopMenu>
      </header>
      <main className={`page ${mainClass}`.trim()} id="main">
        {strip && <ReturnLink app="muse" />}
        {children}
      </main>
      {mode !== null && <ModeModal mode={shownMode ?? 'mock'} lines={modeLines} storageKey={modeKey} />}
    </>
  );
}
