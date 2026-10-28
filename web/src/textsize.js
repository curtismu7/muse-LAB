// Text size: a multiplier kept in this browser (muse.fs) and applied as the CSS variable --fs. The app, the diagram page and the how-it-works page share it.
const KEY = 'muse.fs';
export const SIZES = [0.85, 1, 1.15, 1.3, 1.5];
export const readSize = () => { try { const v = Number(window.localStorage.getItem(KEY)); return SIZES.includes(v) ? v : 1; } catch { return 1; } };
export const applySize = (v) => { document.documentElement.style.setProperty('--fs', String(v)); window.dispatchEvent(new CustomEvent('muse-textsize', { detail: v })); };
export const saveSize = (v) => { try { if (v === 1) window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, String(v)); } catch { /* storage unavailable */ } };
