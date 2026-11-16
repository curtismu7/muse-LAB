import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
const ConnectorSignIn = lazy(() => import('./ConnectorSignIn.jsx')); // carries Ping's DaVinci client SDK
import Diagram from './Diagram.jsx';
import { applyTheme, readTheme } from './ThemeToggle.jsx';
import { applySize, readSize } from './textsize.js';
import './standalone-ui.css';
import './top-menu/top-menu.css';
import './components/JsonPane.css';
import './components/VerifyMark.css';
import './styles.css';

applyTheme(readTheme());
applySize(readSize());

// /diagram is the how-it-works diagram on its own page, public, no sign-in.
// Matches the end of the path so it also works behind the lab proxy's prefix (/agent-connect/diagram).
const onDiagram = window.location.pathname.replace(/\/$/, '').endsWith('/diagram');
// /connector/signin is the sign-in page an assistant's customer lands on from /connector/authorize (the Sign in dialog, pi.flow).
const onConnectorSignIn = window.location.pathname.replace(/\/$/, '').endsWith('/connector/signin');
createRoot(document.getElementById('root')).render(
  <StrictMode>
    {onConnectorSignIn ? <Suspense fallback={null}><ConnectorSignIn /></Suspense> : onDiagram ? <Diagram /> : <App />}
  </StrictMode>,
);
