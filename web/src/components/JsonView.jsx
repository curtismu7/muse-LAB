// JsonView: colored, theme-aware JSON display — family shared service (owner, 2026-11-14, Rule 24).
// Vendor byte-for-byte into web/src/components/JsonView.jsx; never edit a lab's copy.
// - Colors by token class (keys top/nested, strings, URLs, ISO dates, id/uuid, scopes, cost,
//   booleans, null/empty) — palette fixed by Rule 24, light and dark, both ≥4.5:1.
// - Per-pane Colored/Raw toggle. Raw is plain text through the lab's visible() guard.
// - Strings ALWAYS pass the lab's visible() text guard in both modes: control and bidi
//   characters render as visible escapes (class "esc"), never markup.
// - Marks (the only decoration): hl (this step's value), good (verified), bad (denied/tampered),
//   warn (expiring). Pass marks = { "path.to.value": "hl" } using dotted paths; array items use
//   numeric segments ("scope.0").
// - Optional lineNumbers for trace panes.
// The lab owns web/src/safeText.js visible() (same contract as shared/json/Json.jsx).
import React, { useEffect, useMemo, useState } from "react";

const PALETTE = {
  light: {
    key: "#a1123c", nestedKey: "#0b6a9e", string: "#177a3e", url: "#0b6a9e",
    date: "#9a3412", id: "#b45309", idBg: "rgba(180,83,9,.08)", scope: "#1d4ed8",
    scopeBg: "rgba(29,78,216,.07)", number: "#b45309", cost: "#166534",
    true: "#0f766e", trueBg: "rgba(15,118,110,.08)", false: "#b91c1c",
    falseBg: "rgba(185,28,28,.07)", nullLit: "#64748b", punct: "#7b8794",
    esc: "#7c3aed", escBg: "rgba(124,58,237,.06)", bg: "#f4f6f8", border: "#d8dde3",
    ln: "#94a3b8",
  },
  dark: {
    key: "#ff9db3", nestedKey: "#7cc4ff", string: "#7ee2a0", url: "#7cc4ff",
    date: "#ffa86b", id: "#ffc46b", idBg: "rgba(255,196,107,.09)", scope: "#93c5fd",
    scopeBg: "rgba(147,197,253,.09)", number: "#ffc46b", cost: "#86efac",
    true: "#5eead4", trueBg: "rgba(94,234,212,.09)", false: "#fca5a5",
    falseBg: "rgba(252,165,165,.09)", nullLit: "#8b98a5", punct: "#8b98a5",
    esc: "#c4b5fd", escBg: "rgba(196,181,253,.07)", bg: "#0f1a26", border: "#3a444e",
    ln: "#64748b",
  },
};

const RE_URL = /^https?:\/\//i;
const RE_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$|^\d{10,13}$/;
const RE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_KEYS = new Set(["scope", "scopes", "permissions", "granted_scopes"]);
const COST_KEYS = new Set(["cost", "price", "cost_estimate", "amount_usd"]);

function classify(key, value, depth) {
  if (typeof value === "string") {
    if (RE_URL.test(value)) return "url";
    if (RE_DATE.test(value)) return "date";
    if (RE_ID.test(value)) return "id";
    if (key && SCOPE_KEYS.has(key)) return "scope";
    return "string";
  }
  if (typeof value === "number") {
    if (key && (COST_KEYS.has(key) || key.startsWith("cost_") || key.startsWith("price_"))) return "cost";
    return "number";
  }
  if (value === true) return "true";
  if (value === false) return "false";
  if (value === null) return "nullLit";
  if (Array.isArray(value) && value.length === 0) return "empty";
  if (typeof value === "object" && Object.keys(value).length === 0) return "empty";
  return "punct";
}

function styleFor(cls, pal) {
  const s = { color: pal[cls] ?? pal.punct };
  if (cls === "id") { s.background = pal.idBg; s.borderRadius = 3; s.padding = "0 3px"; }
  if (cls === "scope") { s.background = pal.scopeBg; s.borderRadius = 3; s.padding = "0 3px"; s.fontWeight = 600; }
  if (cls === "true") { s.background = pal.trueBg; s.borderRadius = 3; s.padding = "0 4px"; s.fontWeight = 700; }
  if (cls === "false") { s.background = pal.falseBg; s.borderRadius = 3; s.padding = "0 4px"; s.fontWeight = 700; }
  if (cls === "cost") s.fontWeight = 700;
  if (cls === "url") s.textDecoration = "underline dotted";
  if (cls === "nullLit" || cls === "empty") s.fontStyle = "italic";
  return s;
}

export default function JsonView({ value, label, testId, marks = {}, lineNumbers = false, defaultMode = "colored" }) {
  const [mode, setMode] = useState(defaultMode === "raw" ? "raw" : "colored");
  const [theme, setTheme] = useState(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    const read = () => {
      const attr = document.documentElement.getAttribute("data-theme");
      if (attr === "dark" || attr === "light") return setTheme(attr);
      setTheme(window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", read);
    return () => { mo.disconnect(); mq?.removeEventListener?.("change", read); };
  }, []);
  const pal = PALETTE[theme] || PALETTE.light;
  const rawText = useMemo(() => (typeof value === "string" ? value : JSON.stringify(value, null, 2)), [value]);

  let lineNo = 0;
  const render = (node, key, depth, path) => {
    const mark = marks[path];
    const markStyle = mark === "hl" ? { background: theme === "dark" ? "#4a3b12" : "#fef3c7", outline: `1.5px solid ${theme === "dark" ? "#a3841d" : "#d9a514"}`, borderRadius: 3 }
      : mark === "bad" ? { background: theme === "dark" ? "#450a0a" : "#fee2e2", color: theme === "dark" ? "#fca5a5" : "#b91c1c", textDecoration: "line-through", borderRadius: 3 }
      : mark === "good" ? { background: theme === "dark" ? "#0d3320" : "#dcfce7", color: theme === "dark" ? "#86efac" : "#166534", borderRadius: 3 }
      : mark === "warn" ? { background: theme === "dark" ? "#431f07" : "#ffedd5", color: theme === "dark" ? "#ffa86b" : "#9a3412", borderRadius: 3 }
      : null;
    const wrap = (children) => (markStyle ? <span style={markStyle}>{children}</span> : children);
    const line = () => (lineNumbers ? <span style={{ display: "inline-block", width: "2.2em", color: pal.ln, opacity: 0.55, userSelect: "none" }}>{++lineNo}</span> : null);

    if (typeof value !== "object" || value === null) {
      // scalar at top level
      const cls = classify(null, value, 0);
      return <span style={{ color: pal[cls] }}>{visibleSafe(value)}</span>;
    }
    if (Array.isArray(node)) {
      if (node.length === 0) return <span style={{ color: pal.nullLit, fontStyle: "italic" }}>[]</span>;
      return (
        <span>
          <span style={{ color: pal.punct }}>[</span>
          {node.map((v, i) => (
            <div key={i} style={{ marginLeft: 14 }}>{line()}{render(v, key, depth + 1, `${path}${path ? "." : ""}${i}`)}{i < node.length - 1 && <span style={{ color: pal.punct }}>,</span>}</div>
          ))}
          <span style={{ color: pal.punct }}>]</span>
        </span>
      );
    }
    const keys = Object.keys(node);
    if (keys.length === 0) return <span style={{ color: pal.nullLit, fontStyle: "italic" }}>{"{}"}</span>;
    return (
      <span>
        <span style={{ color: pal.punct }}>{"{"}</span>
        {keys.map((k, i) => (
          <div key={k} style={{ marginLeft: depth === 0 ? 0 : 14 }}>{line()}
            <span style={{ color: depth === 0 ? pal.key : pal.nestedKey, fontWeight: depth === 0 ? 600 : 400 }}>"{visibleSafe(k)}"</span>
            <span style={{ color: pal.punct }}>: </span>
            {render(node[k], k, depth, `${path}${path ? "." : ""}${k}`)}
            {i < keys.length - 1 && <span style={{ color: pal.punct }}>,</span>}
          </div>
        ))}
        <span style={{ color: pal.punct }}>{"}"}</span>
      </span>
    );
  };

  const renderValue = (v, k, path) => {
    const cls = classify(k, v, 0);
    const mark = marks[path];
    const markStyle = mark === "hl" ? { background: theme === "dark" ? "#4a3b12" : "#fef3c7", outline: `1.5px solid ${theme === "dark" ? "#a3841d" : "#d9a514"}`, borderRadius: 3 }
      : mark === "bad" ? { background: theme === "dark" ? "#450a0a" : "#fee2e2", color: theme === "dark" ? "#fca5a5" : "#b91c1c", textDecoration: "line-through", borderRadius: 3 }
      : mark === "good" ? { background: theme === "dark" ? "#0d3320" : "#dcfce7", color: theme === "dark" ? "#86efac" : "#166534", borderRadius: 3 }
      : mark === "warn" ? { background: theme === "dark" ? "#431f07" : "#ffedd5", color: theme === "dark" ? "#ffa86b" : "#9a3412", borderRadius: 3 }
      : null;
    if (typeof v === "object" && v !== null) return render(v, k, 1, path);
    const body = visibleSafe(v);
    return wrapMark(<span style={styleFor(cls, pal)}>{body}</span>, markStyle);
  };

  // top-level renderer (objects/arrays)
  const renderRoot = () => {
    if (typeof value !== "object" || value === null) {
      return <span style={{ color: pal[classify(null, value, 0)] }}>{visibleSafe(value)}</span>;
    }
    const isArray = Array.isArray(value);
    const keys = isArray ? value.map((_, i) => i) : Object.keys(value);
    if (keys.length === 0) return <span style={{ color: pal.nullLit, fontStyle: "italic" }}>{isArray ? "[]" : "{}"}</span>;
    return (
      <span>
        <span style={{ color: pal.punct }}>{isArray ? "[" : "{"}</span>
        {keys.map((k, i) => (
          <div key={String(k)} style={{ marginLeft: 14 }}>{line()}
            {!isArray && <span style={{ color: pal.key, fontWeight: 600 }}>"{visibleSafe(k)}"</span>}
            {!isArray && <span style={{ color: pal.punct }}>: </span>}
            {renderValue(value[k], isArray ? null : k, String(k))}
            {i < keys.length - 1 && <span style={{ color: pal.punct }}>,</span>}
          </div>
        ))}
        <span style={{ color: pal.punct }}>{isArray ? "]" : "}"}</span>
      </span>
    );
  };

  function wrapMark(children, markStyle) {
    return markStyle ? <span style={markStyle}>{children}</span> : children;
  }

  // visibleSafe: use the lab's visible() when present; otherwise minimal inline fallback
  function visibleSafe(v) {
    if (typeof v !== "string") return JSON.stringify(v);
    try {
      // eslint-disable-next-line no-undef
      if (typeof visible === "function") return visible(v);
    } catch { /* fall through */ }
    // inline fallback: control/bidi chars as visible escapes
    return v.replace(/[\u0000-\u0008\u000b-\u001f\u202a-\u202e\u2066-\u2069\u007f]/g,
      (c) => `‹U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}›`);
  }

  return (
    <div data-testid={testId || "json-view"}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
        <button
          type="button"
          data-testid={`${testId || "json-view"}-toggle`}
          aria-pressed={mode === "colored"}
          onClick={() => setMode(m => (m === "colored" ? "raw" : "colored"))}
          style={{ font: "inherit", fontSize: 11, padding: "2px 10px", borderRadius: 6, cursor: "pointer", border: `1px solid ${pal.border}`, background: mode === "colored" ? "#a1123c" : "transparent", color: mode === "colored" ? "#fff" : "inherit" }}
        >
          {mode === "colored" ? "Colored" : "Raw"}
        </button>
        {label && <span style={{ fontSize: 11, opacity: 0.7 }}>{label}</span>}
      </div>
      <pre
        data-testid={`${testId || "json-view"}-pre`}
        aria-label={label}
        style={{ margin: 0, padding: "10px 14px", borderRadius: 8, overflowX: "auto", fontSize: 12.5, lineHeight: 1.6, background: pal.bg, border: `1px solid ${pal.border}`, fontFamily: '"IBM Plex Mono",ui-monospace,monospace' }}
      >
        {mode === "colored" ? renderRoot() : visibleSafe(rawText)}
      </pre>
    </div>
  );
}
