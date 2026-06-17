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

afterEach(() => {
  cleanup();
});
