import Json from './components/JsonPane.jsx';

// The raw request and response of one discovery / connect step, as the HTTP text it is. The shared JsonPane keeps the request line and the
// status line with the headers as text and gives the JSON body its own Form | JSON pane. `hot` marks the keys that matter in this lab's
// bodies: the JSON-RPC method being called, the resource and its authorization server, where to sign in, how (PKCE), and where to register.
const HOT = ['method', 'resource', 'authorization_servers', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'client_id_metadata_document_supported', 'code_challenge_methods_supported', 'code_challenge_method', 'redirect_uris'];

const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const requestText = (q) => `${q.method} ${q.url}${q.body ? `\n\n${pretty(q.body)}` : ''}`;
const responseText = (r) => `HTTP ${r.status}${Object.entries(r.headers ?? {}).map(([k, v]) => `\n${k}: ${v}`).join('')}${r.body !== undefined ? `\n\n${pretty(r.body)}` : ''}`;

export default function RawStep({ step, testId }) {
  return (
    <>
      <Json value={requestText(step.request)} label={`Step ${step.n} request`} testId={`${testId}-req`} hot={HOT} />
      {step.response && <Json value={responseText(step.response)} label={`Step ${step.n} response`} testId={`${testId}-res`} hot={HOT} />}
    </>
  );
}
