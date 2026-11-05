import React, { useState } from 'react';

// System, Light or Dark. The choice is kept in this browser and shared by the app, the diagram page and the how-it-works page.
const KEY = 'muse.theme';
const ORDER = ['system', 'light', 'dark'];
const LABEL = { system: 'System', light: 'Light', dark: 'Dark' };
export const readTheme = () => { try { const t = window.localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; } };
export const applyTheme = (t) => {
  const r = document.documentElement;
  if (t === 'system') {
    // System mode follows the OS. The stylesheet has no @media (prefers-color-scheme) (CSS standard),
    // so system mode applies dark by setting data-theme when the OS is dark, and clears it otherwise.
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) r.setAttribute('data-theme', 'dark'); else r.removeAttribute('data-theme');
  } else r.setAttribute('data-theme', t);
};

export default function ThemeToggle({ className = '' }) {
  const [theme, setTheme] = useState(readTheme);
  React.useEffect(() => {
    if (theme !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [theme]);
  const next = () => {
    const n = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    setTheme(n); applyTheme(n);
    try { if (n === 'system') window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, n); } catch { /* storage unavailable */ }
  };
  return <button type="button" className={`theme-toggle ${className}`.trim()} onClick={next} aria-label={`Theme: ${LABEL[theme]}. Click to change.`} data-testid="theme-toggle">Theme: {LABEL[theme]}</button>;
}
