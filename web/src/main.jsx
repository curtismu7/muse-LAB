import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
const ConnectorSignIn = lazy(() => import('./ConnectorSignIn.jsx')); // carries Ping's DaVinci client SDK
import MuseFlow from './MuseFlow.jsx';
import ThemeToggle, { applyTheme, readTheme } from './ThemeToggle.jsx';
import TextSize from './TextSize.jsx';
import { applySize, readSize } from './textsize.js';
import './standalone-ui.css';
import './top-menu/top-menu.css';
import './styles.css';

applyTheme(readTheme());
applySize(readSize());

// /diagram is the how-it-works diagram on its own page, public, no sign-in.
// Matches the end of the path so it also works behind the lab proxy's prefix (/agent-connect/diagram).
const onDiagram = window.location.pathname.replace(/\/$/, '').endsWith('/diagram');
// /connector/signin is the sign-in page an assistant's customer lands on from /connector/authorize (the Sign in dialog, pi.flow).
const onConnectorSignIn = window.location.pathname.replace(/\/$/, '').endsWith('/connector/signin');
const Diagram = () => (
  <main className="diagram-page">
    <p className="small diagram-nav"><span><a href="/">Back to Personal Agent</a> &middot; <a href="/how-agent-connect-works.html">How it works, in words</a></span><span className="diagram-nav__tools"><TextSize /><ThemeToggle /></span></p>
    <h1>How Personal Agent works</h1>
    <MuseFlow />
  </main>
);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {onConnectorSignIn ? <Suspense fallback={null}><ConnectorSignIn /></Suspense> : onDiagram ? <Diagram /> : <App />}
  </StrictMode>,
);
