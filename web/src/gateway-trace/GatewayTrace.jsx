import React from "react";
import Json from "../components/JsonPane";
import "./gateway-trace.css";

/*
  "What Privilege did": for each call an app makes to the Privilege gateway, the exact request, the exact
  response, and the decisions the gateway made in between. The family's one panel for it (Rule 25).

  <GatewayTrace exchanges={[{ step: 2, title: "Gateway check: tools/list", status: 200, trace }]} source="real" />

  trace = {                                         (built server-side by gatewayTrace.js, vendored beside this)
    source: "mock" | "real",
    request:  { method, url, headers, body },
    response: { status, headers, body } | null,     // null: the gateway was never reached
    decisions: [{ id, label, outcome: "pass"|"fail"|"skipped"|"info",
                  basis: "checked"|"inferred"|"observed", evidence }],
    record: string | null,                          // where the gateway itself records this call
    at?, requestId?,                                // to find that record
    setup?: [{ label, status }]                     // the session calls around it (initialize, ...), one line each
  }

  basis: "checked" = the lab's simulated gateway computed it; "observed" = read from the response;
  "inferred" = the real gateway returns no per-check detail, so it is read from the outcome and labelled as such.
  Never present an inferred decision as if the gateway had reported it.

  The bodies are drawn by the shared JsonPane (Rule 24): the lab vendors it at web/src/components/JsonPane.jsx.
*/

const OUTCOME_LABEL = { pass: "PASS", fail: "FAIL", skipped: "NOT REACHED", info: "INFO" };
const BASIS_NOTE = { inferred: "inferred from the outcome", observed: "observed in the response" };

const asText = (v) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2));
const headerLines = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`);
const transcript = (first, headers, body) => {
  const text = asText(body);
  return [first, ...headerLines(headers), ...(text ? ["", text] : [])].join("\n");
};

export const requestText = (r) => transcript(`${r.method} ${r.url}`, r.headers, r.body);
export const responseText = (r) => transcript(`HTTP ${r.status}`, r.headers, r.body);

const HOT = ["error", "isError", "tools", "result"];

function Exchange({ ex }) {
  const t = ex.trace;
  const passed = t.decisions.filter((d) => d.outcome === "pass").length;
  const notes = t.decisions.filter((d) => d.outcome === "info").length;
  const failed = t.decisions.find((d) => d.outcome === "fail");
  // An "info" decision (a hold, a pause, an answer the panel does not interpret) is never counted as passed.
  const summary = failed ? `refused at: ${failed.label}` : notes ? `${passed} passed, ${notes} for information` : `all ${passed} decisions passed`;
  const id = `trace-${ex.step}`;
  return (
    <details className="gw-ex" open data-testid={id}>
      <summary>
        <span className="gw-num">{ex.step}</span>
        <strong>{ex.title}</strong>
        {ex.status != null && <span className="gw-chip" data-outcome={ex.status < 400 ? "pass" : "fail"}>HTTP {ex.status}</span>}
        <span className="gw-sum">{summary}</span>
      </summary>

      <h4>Decisions the gateway made</h4>
      <ol className="gw-decisions" data-testid={`${id}-decisions`}>
        {t.decisions.map((d) => (
          <li key={d.id} data-outcome={d.outcome}>
            <span className="gw-chip" data-outcome={d.outcome}>{OUTCOME_LABEL[d.outcome] || d.outcome}</span>
            <div>
              <strong>{d.label}</strong> <span className="gw-evidence">{d.evidence}</span>
              {BASIS_NOTE[d.basis] && <span className="gw-tag">{BASIS_NOTE[d.basis]}</span>}
            </div>
          </li>
        ))}
      </ol>

      <div className="gw-io">
        <div>
          <h4>Request sent to the gateway</h4>
          <Json value={requestText(t.request)} label="Request to the gateway" testId={`${id}-request`} hot={HOT} />
        </div>
        <div>
          <h4>Response from the gateway</h4>
          {t.response
            ? <Json value={responseText(t.response)} label="Response from the gateway" testId={`${id}-response`} hot={HOT} />
            : <p className="gw-muted" data-testid={`${id}-response`}>No response: the gateway could not be reached.</p>}
        </div>
      </div>

      {t.setup && t.setup.length > 0 && (
        <p className="gw-muted gw-setup" data-testid={`${id}-setup`}>
          <strong>Session calls around it:</strong> {t.setup.map((s) => `${s.label} ${s.status == null ? "no answer" : `HTTP ${s.status}`}`).join(", ")}.
        </p>
      )}

      {t.record && (
        <p className="gw-muted gw-record">
          <strong>{t.source === "real" ? "The gateway's own record" : "The gateway log line this call produces"}:</strong>{" "}
          {t.record}
          {(t.at || t.requestId) && <> Time {t.at}{t.requestId ? `, request ${t.requestId}` : ""}.</>}
        </p>
      )}
    </details>
  );
}

export default function GatewayTrace({ exchanges, source, title = "What Privilege did" }) {
  const list = Array.isArray(exchanges) ? exchanges : [];
  return (
    <section className="gw-trace" data-testid="gateway-trace" aria-label={title}>
      <h2>{title}</h2>
      <p className="gw-lead">
        Every request the agent sent to the Privilege gateway, exactly what came back, and the decisions the gateway
        made in between.
      </p>
      <p className="gw-muted" data-testid="gateway-trace-basis">
        {source === "real"
          ? "Real gateway. The requests and responses are exact. The gateway answers with a status and a body, not a per-check breakdown, so decisions marked \"inferred\" are read from the outcome; the gateway log is the authoritative record."
          : "Simulated: the lab's in-process gateway runs the checks in the same order, so these decisions are what it computed. Real mode shows the actual gateway."}
      </p>
      {list.length === 0
        ? <p className="gw-muted" data-testid="gateway-trace-empty">Press Run: each request, each response and each decision appears here.</p>
        : list.map((ex) => <Exchange key={ex.step} ex={ex} />)}
    </section>
  );
}
