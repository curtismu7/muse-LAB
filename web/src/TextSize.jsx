import { useEffect, useState } from 'react';
import { SIZES, applySize, readSize, saveSize } from './textsize.js';

// A-, the current size, A+. Smaller and larger stop at the ends of the list.
export function useTextSize() {
  const [fs, setFs] = useState(readSize);
  useEffect(() => { const on = (e) => setFs(e.detail); window.addEventListener('muse-textsize', on); return () => window.removeEventListener('muse-textsize', on); }, []);
  return fs;
}

export default function TextSize({ className = '' }) {
  const fs = useTextSize();
  const i = SIZES.indexOf(fs);
  const set = (v) => { saveSize(v); applySize(v); };
  return (
    <span className={`text-size ${className}`.trim()} role="group" aria-label="Text size" data-testid="text-size">
      <button type="button" onClick={() => set(SIZES[Math.max(0, i - 1)])} disabled={i <= 0} aria-label="Smaller text" data-testid="text-smaller">A&minus;</button>
      <span className="text-size__now" aria-live="polite" data-testid="text-now">{Math.round(fs * 100)}%</span>
      <button type="button" onClick={() => set(SIZES[Math.min(SIZES.length - 1, i + 1)])} disabled={i >= SIZES.length - 1} aria-label="Larger text" data-testid="text-larger">A+</button>
    </span>
  );
}
