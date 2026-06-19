// Vitest + Testing Library setup (jsdom). Registers the jest-dom matchers
// (toBeInTheDocument, toHaveTextContent, …) and clears the DOM between tests.
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The default findBy*/waitFor timeout is 1s. When the root `npm test` runs the
// app and dashboard workspaces concurrently, CPU saturation can make a correct
// async render miss that 1s window — a false failure. Give async assertions
// real headroom (the vitest testTimeout in vite.config.ts is set above this).
configure({ asyncUtilTimeout: 5000 });

// jsdom has no ResizeObserver, but components that observe element size construct
// one on mount (useAutoGrowTextarea). A no-op stub lets them render in tests.
// Tests that need to DRIVE the callback override this locally with vi.stubGlobal
// (e.g. useAutoGrowTextarea.test).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
});
