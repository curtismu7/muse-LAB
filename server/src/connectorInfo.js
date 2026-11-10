// GET /api/connector/info: the public facts a person types or pastes into muse.ai to connect to the Airline Connector.
// Built from a fixed list of fields, never from the config object or the environment, so a secret, a token or an internal setting cannot end up in it.
import { connectorConfig, toolsFor } from './connector.js';

export const DEFAULT_AIRLINE = 'SkyHigh';
export const TOKEN_AUTH = 'none (public client, PKCE S256)';

// A host muse.ai (a cloud service) cannot reach: loopback, private and link-local ranges, names that only resolve locally (*.local, *.localhost, *.internal,
// *.lan, *.ping.demo, local.ping-devops.com) and any dotless name. Anything else is treated as public.
export function isPublicHost(hostname) {
  let h = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h) return false;
  if (h.includes(':')) {
    // IPv6: loopback, unspecified, unique local (fc00::/7), link-local (fe80::/10) and IPv4-mapped addresses are not public.
    if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith('::ffff:')) return false;
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (v4.slice(1).some((o) => Number(o) > 255)) return false;
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (!h.includes('.')) return false;
  if (h === 'localhost' || h === 'local.ping-devops.com') return false;
  return !['.localhost', '.local', '.internal', '.lan', '.ping.demo'].some((suffix) => h.endsWith(suffix));
}

export function connectorInfo(connector, env, live) {
  if (!connector) return null;
  const cfg = connectorConfig(env, live);
  let host = '';
  try { host = new URL(connector.url).hostname; } catch { host = ''; }
  const airline = connector.airline || DEFAULT_AIRLINE;
  return {
    url: connector.url,
    clientId: cfg?.staticClient?.id ?? null,
    tokenAuth: TOKEN_AUTH,
    scope: connector.scope,
    redirectUris: [...(cfg?.staticClient?.redirectUris ?? [])],
    airline,
    publicReachable: isPublicHost(host),
    tools: toolsFor(airline).map((t) => t.name),
  };
}
