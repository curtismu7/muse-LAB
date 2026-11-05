import React, { useState } from 'react';

// Auto, Light or Dark. The choice is kept in this browser and shared by the app, the diagram page and the how-it-works page.
// The picker only sets data-theme; the shared stylesheet does the rest ("auto" follows the system setting).
const KEY = 'muse.theme';
const THEMES = [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']];
export const readTheme = () => { try { const t = window.localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; } };
export const applyTheme = (t) => {
  const r = document.documentElement;
  if (t === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', t);
};

export default function ThemeToggle({ className = '' }) {
  const [theme, setTheme] = useState(readTheme);
  const pick = (t) => {
    setTheme(t); applyTheme(t);
    try { if (t === 'auto') window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, t); } catch { /* storage unavailable */ }
  };
  return (
    <label className={`theme-toggle ${className}`.trim()}>
      Theme
      <select value={theme} onChange={(e) => pick(e.target.value)} data-testid="theme-toggle">
        {THEMES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
  );
}
