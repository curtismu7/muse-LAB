// GatewayTrace tests (vitest + Testing Library + jsdom). Run where the folder is vendored
// (web/src/gateway-trace/, next to web/src/components/JsonPane.jsx).
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import GatewayTrace, { requestText, responseText } from "./GatewayTrace";
import { setJsonView } from "../components/JsonPane";

const trace = (over = {}) => ({
  source: "real",
  request: { method: "POST", url: "https://gw.example/demo/mcp", headers: { authorization: "Bearer <agent key, 12 characters, kept on the server>" }, body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } },
  response: { status: 200, headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "whoami" }] } } },
  decisions: [
    { id: "authenticated", label: "Agent key", outcome: "pass", basis: "inferred", evidence: "the gateway recognised the agent key" },
    { id: "grant", label: "Grant", outcome: "pass", basis: "inferred", evidence: "allows 1 tool" },
  ],
  record: "Look for the gateway log line for this key and call.",
  at: "2026-11-15T20:00:00Z",
  requestId: "req-1",
  ...over,
});
const ex = (t, step = 1) => ({ step, title: "Gateway check: tools/list", status: t.response?.status ?? null, trace: t });

beforeEach(() => setJsonView("raw"));

describe("GatewayTrace", () => {
  test("empty: tells the visitor to press Run, and says which kind of gateway this is", () => {
    render(<GatewayTrace exchanges={[]} source="mock" />);
    expect(screen.getByTestId("gateway-trace-empty")).toBeInTheDocument();
    expect(screen.getByTestId("gateway-trace-basis")).toHaveTextContent(/Simulated/);
  });

  test("real: says the gateway reports no per-check breakdown, so inferred decisions are labelled", () => {
    render(<GatewayTrace exchanges={[ex(trace())]} source="real" />);
    expect(screen.getByTestId("gateway-trace-basis")).toHaveTextContent(/Real gateway/);
    const list = screen.getByTestId("trace-1-decisions");
    expect(within(list).getAllByText("inferred from the outcome")).toHaveLength(2);
    expect(screen.getByTestId("trace-1")).toHaveTextContent("all 2 decisions passed");
  });

  test("a held call is not summarised as everything passed: an info decision is counted apart", () => {
    const t = trace({
      response: { status: 403, headers: {}, body: { error: "held for approval" } },
      decisions: [
        { id: "scope", label: "Scope", outcome: "pass", basis: "checked", evidence: "in scope" },
        { id: "rule", label: "Approval rule", outcome: "info", basis: "checked", evidence: "held for a human" },
      ],
    });
    render(<GatewayTrace exchanges={[ex(t)]} source="mock" />);
    expect(screen.getByTestId("trace-1")).toHaveTextContent("1 passed, 1 for information");
    expect(screen.getByTestId("trace-1")).not.toHaveTextContent(/all \d+ decisions passed/);
  });

  test("a refusal names where it was refused, and the later decision shows NOT REACHED", () => {
    const t = trace({
      response: { status: 401, headers: {}, body: "invalid virtual key" },
      decisions: [
        { id: "authenticated", label: "Agent key", outcome: "fail", basis: "inferred", evidence: "refused" },
        { id: "grant", label: "Grant", outcome: "skipped", basis: "inferred", evidence: "not reached" },
      ],
    });
    render(<GatewayTrace exchanges={[ex(t)]} source="real" />);
    expect(screen.getByTestId("trace-1")).toHaveTextContent("refused at: Agent key");
    expect(screen.getByText("NOT REACHED")).toBeInTheDocument();
  });

  test("the request and the response are the exact transcript, drawn by the shared JsonPane (never capped)", () => {
    render(<GatewayTrace exchanges={[ex(trace())]} source="real" />);
    const req = screen.getByTestId("trace-1-request-body");
    expect(req.textContent).toContain('"method": "tools/list"');
    expect(screen.getByTestId("trace-1-request-head").textContent).toContain("POST https://gw.example/demo/mcp");
    expect(screen.getByTestId("trace-1-response-body").textContent).toContain('"name": "whoami"');
    for (const el of [req, screen.getByTestId("trace-1-response-body")]) {
      expect(getComputedStyle(el).maxHeight === "" || getComputedStyle(el).maxHeight === "none").toBe(true);
    }
  });

  test("a long body is shown whole, not cut mid-JSON", () => {
    const tools = Array.from({ length: 400 }, (_, i) => ({ name: `tool-${i}`, description: "x".repeat(40) }));
    const t = trace({ response: { status: 200, headers: {}, body: { result: { tools } } } });
    render(<GatewayTrace exchanges={[ex(t)]} source="real" />);
    const text = screen.getByTestId("trace-1-response-body").textContent;
    expect(text).toContain("tool-399");
    expect(text).not.toMatch(/more characters not shown/);
  });

  test("no response: says the gateway could not be reached, and shows only the request", () => {
    const t = trace({ response: null, decisions: [{ id: "reach", label: "Reach the gateway", outcome: "fail", basis: "observed", evidence: "unreachable" }] });
    render(<GatewayTrace exchanges={[ex(t)]} source="real" />);
    expect(screen.getByTestId("trace-1-response")).toHaveTextContent("could not be reached");
    expect(screen.getByText("observed in the response")).toBeInTheDocument();
  });

  test("the session calls around the call and the gateway's own record are shown", () => {
    const t = trace({ setup: [{ label: "initialize", status: 200 }, { label: "session close", status: null }] });
    render(<GatewayTrace exchanges={[ex(t)]} source="real" />);
    expect(screen.getByTestId("trace-1-setup")).toHaveTextContent("initialize HTTP 200, session close no answer");
    expect(screen.getByTestId("trace-1")).toHaveTextContent("The gateway's own record");
    expect(screen.getByTestId("trace-1")).toHaveTextContent("request req-1");
  });

  test("a simulated trace calls its record the log line the call produces, and a checked decision has no 'inferred' tag", () => {
    const t = trace({ source: "mock", decisions: [{ id: "sig", label: "Signature", outcome: "pass", basis: "checked", evidence: "verified" }] });
    render(<GatewayTrace exchanges={[ex(t)]} source="mock" />);
    expect(screen.getByTestId("trace-1")).toHaveTextContent("The gateway log line this call produces");
    expect(screen.queryByText("inferred from the outcome")).toBeNull();
  });

  test("requestText / responseText: the first line, the headers, a blank line, then the body", () => {
    const t = trace();
    expect(requestText(t.request).split("\n").slice(0, 3)).toEqual(["POST https://gw.example/demo/mcp", "authorization: Bearer <agent key, 12 characters, kept on the server>", ""]);
    expect(responseText({ status: 204, headers: {}, body: null })).toBe("HTTP 204");
  });

  test("basisNote replaces the sentence about what kind of gateway this is, in either mode", () => {
    const { rerender } = render(<GatewayTrace exchanges={[]} source="mock" basisNote="Local engine: the lab's own policy runs here." />);
    expect(screen.getByTestId("gateway-trace-basis")).toHaveTextContent("Local engine: the lab's own policy runs here.");
    expect(screen.getByTestId("gateway-trace-basis")).not.toHaveTextContent(/Real mode shows the actual gateway/);
    rerender(<GatewayTrace exchanges={[]} source="real" basisNote="Local engine." />);
    expect(screen.getByTestId("gateway-trace-basis")).toHaveTextContent("Local engine.");
    expect(screen.getByTestId("gateway-trace-basis")).not.toHaveTextContent(/Real gateway/);
  });

  test("a custom title is used for the heading and the label", () => {
    render(<GatewayTrace exchanges={[]} source="mock" title="What the gateway did" />);
    expect(screen.getByRole("heading", { name: "What the gateway did" })).toBeInTheDocument();
  });
});
