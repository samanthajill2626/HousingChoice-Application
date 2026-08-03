// Vitest + Testing Library setup (jsdom). Registers the jest-dom matchers
// (toBeInTheDocument, toHaveTextContent, …) and clears the DOM between tests.
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// The default findBy*/waitFor timeout is 1s. When the root `npm test` runs the
// app and dashboard workspaces concurrently, CPU saturation can make a correct
// async render miss that 1s window — a false failure. Give async assertions
// real headroom (the vitest testTimeout in vite.config.ts is set above this).
configure({ asyncUtilTimeout: 5000 });

// Pin the clock to a fixed instant. A bare vi.setSystemTime (NO vi.useFakeTimers)
// mocks ONLY Date - timers stay genuinely real, so waitFor/userEvent and anything
// setTimeout-based are untouched. Components that render "now"-relative date
// vocabulary (expiresOn / closesAt / sendRelative, ...) become deterministic
// forever: a hardcoded fixture date can never quietly expire and flip an
// assertion's tense as the wall clock advances
// (docs/issues/placement-detail-test-wallclock-voucher.md).
//
// Installed at MODULE level, not just beforeEach, because setup files import
// before the test module does and some suites build now-relative fixtures at
// module scope (ToursPage.test's todayAt/sevenDaysFrom) - fixture and component
// must read the SAME frozen clock. The beforeEach re-pin restores the freeze
// after a suite runs vi.useRealTimers().
//
// Suites that need FULL fake timers must call vi.useRealTimers() first to release
// this Date pin, then vi.useFakeTimers() (vitest throws a self-explanatory error
// if you forget). Their fake clock then anchors to the real now, as it did before
// the pin existed. Conventions under the pin: keep vocabulary assertions
// tense-loose (/expires Aug 2/), don't pin exact relative copy ("(in 32d)").
const PINNED_NOW = new Date('2026-07-01T12:00:00Z');
vi.setSystemTime(PINNED_NOW);
beforeEach(() => {
  vi.setSystemTime(PINNED_NOW);
});

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

// jsdom does no layout and so implements no scrollIntoView, but menus call it to
// reveal the focused item on open (StatusMenu). A no-op stub lets them render;
// tests that ASSERT the call spy on this with vi.spyOn (e.g. StatusMenu.test).
if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {};
}

afterEach(() => {
  cleanup();
});
