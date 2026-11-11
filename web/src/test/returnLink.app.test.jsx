// Opened from Customer Agent LAB: the strip and the header Back button show; nothing is preselected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { returnLinkFor } from "../return-link/returnTargets.js";
import App from "../App.jsx";

// The /api/session shape the server sends (server/src/index.js), signed out, Mock.
const SESSION = {
  customer: { brandName: "Personal Agent", agentName: "Personal Agent" }, workspaceId: "w1", protectMode: "mock", signedIn: false, persona: null,
  picker: false, hosted: false, connector: null, pf: null, mode: "mock", live: { available: false }, agent: { enabled: false }, discovery: null,
  liveAuth: { registered: false, signedIn: false, claims: null, steps: [], error: null, ask: null, answer: null },
  userLogin: null, assistant: null, personas: [], tools: [], decisions: [], held: [],
};
const NOTE = { name: "Opened from Customer Agent LAB" };
beforeEach(() => {
  globalThis.fetch = vi.fn(async (url) => {
    const body = url === "/api/session" ? SESSION : url === "/api/info" ? { source: "mock", realAvailable: false, realReason: "x" } : {};
    return { ok: true, status: 200, json: async () => body };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("return link", () => {
  it("the vendored files match return-link.sha256, which names the parent commit", () => {
    const dir = path.join(process.cwd(), "src", "return-link");
    const text = fs.readFileSync(path.join(dir, "return-link.sha256"), "utf8");
    expect(text.split("\n")[0]).toMatch(/^# vendored byte for byte from curtismu7\/AI-DEMO-Standalone shared\/return-link at [0-9a-f]{7,40}/);
    const pins = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
    expect(pins.map(([, f]) => f).sort()).toEqual(["ReturnLink.jsx", "ReturnLink.test.jsx", "returnTargets.js"]);
    for (const [h, f] of pins) expect(createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex"), f).toBe(h);
  });

  it("?from=customer-agent: banner first, strip right below, header Back in the shell bar", async () => {
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC48&vertical=banking");
    render(<App />);
    const note = await screen.findByRole("note", NOTE);
    expect(note.textContent).toContain("UC48");
    expect(document.querySelector("section.chat > aside.banner").nextElementSibling).toBe(note);
    expect(document.querySelector("header.shell-bar button.return-link--header")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /Back to Customer Agent LAB/ })).toHaveLength(2);
  });

  it("no from, an unknown from or a bad id: no strip, no button", async () => {
    for (const q of ["/", "/?from=elsewhere&uc=UC-MUSE1", "/?from=customer-agent&uc=%3Cb%3E", "/?from=customer-agent&uc=UC-MUSE1&vertical=a%20b"]) {
      window.history.replaceState(null, "", q);
      const { container } = render(<App />);
      await vi.waitFor(() => expect(container.querySelector("aside.banner")).not.toBeNull());
      expect(screen.queryByRole("button", { name: /Back to/ })).toBeNull();
      expect(screen.queryByRole("note", NOTE)).toBeNull();
      cleanup();
    }
  });

  it("Back goes to the proxy path behind the lab proxy, to the direct URL on the app's own port", () => {
    window.history.replaceState(null, "", "/muse/?from=customer-agent&uc=UC-MUSE2");
    expect(returnLinkFor("muse").href).toBe("/customer-agent/?returned=muse&uc=UC-MUSE2");
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC-MUSE2");
    expect(returnLinkFor("muse").href).toBe("http://127.0.0.1:5603/?returned=muse&uc=UC-MUSE2");
  });
});

  it("?from=ai-demo-standalone: strip names AI Demo Standalone, Back goes to /ai-demo-standalone/ under the proxy", () => {
    window.history.replaceState(null, "", "/muse/?from=ai-demo-standalone&uc=UC12");
    expect(returnLinkFor("muse").href).toBe("/ai-demo-standalone/?returned=muse&uc=UC12");
  });
