import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import MuseFlow from './MuseFlow.jsx';
import ThemeToggle, { applyTheme, readTheme } from './ThemeToggle.jsx';
import TextSize from './TextSize.jsx';
import { applySize, readSize } from './textsize.js';
import './styles.css';

applyTheme(readTheme());
applySize(readSize());

// /diagram is the how-it-works diagram on its own page, public, no sign-in.
const onDiagram = window.location.pathname.replace(/\/$/, '') === '/diagram';
const Diagram = () => (
  <main className="diagram-page">
    <p className="small diagram-nav"><span><a href="/">Back to Muse</a> &middot; <a href="/how-muse-works.html">How it works, in words</a></span><span className="diagram-nav__tools"><TextSize /><ThemeToggle /></span></p>
    <h1>How Muse works</h1>
    <MuseFlow />
  </main>
);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {onDiagram ? <Diagram /> : <App />}
  </StrictMode>,
);
