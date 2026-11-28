import Frame, { PageTitle } from './Frame.jsx';
import MuseFlow from './MuseFlow.jsx';

const DIAGRAM_LINES = { mock: 'A walk-through of the flow. This page calls no PingOne tenant and no gateway, in either mode.', real: 'A walk-through of the flow. This page calls no PingOne tenant and no gateway, in either mode.' };

// /diagram is the how-it-works diagram on its own page, public, no sign-in. The theme and text size live in the shell bar's TopMenu.
export default function Diagram() {
  return (
    <Frame current="diagram" modeLines={DIAGRAM_LINES} modeKey="muse-diagram-mode">
      <div className="diagram-page">
        <p className="small diagram-nav"><span><a href="/">Back to Personal Agent</a> &middot; <a href="/how-agent-connect-works.html">How it works, in words</a></span></p>
        <PageTitle>How Personal Agent works</PageTitle>
        <MuseFlow />
      </div>
    </Frame>
  );
}
