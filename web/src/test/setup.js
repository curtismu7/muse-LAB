// Test setup: jest-dom matchers and a cleanup after every test (the vendored floating-dialog tests rely on both), and a plain in-memory
// localStorage where a Node global one shadows jsdom's without working.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);

if (typeof globalThis.localStorage?.clear !== 'function') {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() },
  });
}
