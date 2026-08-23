import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const moduleCss = readFileSync(join(testDir, 'AppFrame.module.css'), 'utf8');
const indexCss = readFileSync(join(testDir, '..', 'index.css'), 'utf8');

interface CssRule {
  selectors: string[];
  body: string;
}

function rules(source: string): CssRule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!
      .trim()
      .split(',')
      .map((selector) => selector.trim().replace(/\s+/g, ' ')),
    body: match[2]!,
  }));
}

function ruleFor(source: string, selector: string): CssRule {
  const rule = rules(source).find(
    (candidate) => candidate.selectors.length === 1 && candidate.selectors[0] === selector,
  );
  expect(rule, `missing CSS rule for ${selector}`).toBeDefined();
  return rule!;
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = channel((value >> 16) & 0xff);
  const green = channel((value >> 8) & 0xff);
  const blue = channel(value & 0xff);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('AppFrame stylesheet contract', () => {
  it('declares every locked alias only on the sidebar and drawer nav fields', () => {
    const scoped = rules(moduleCss).find(
      (rule) =>
        rule.selectors.length === 2 &&
        rule.selectors.includes('.nonProduction .sidebar') &&
        rule.selectors.includes('.nonProduction .drawer'),
    );
    expect(scoped).toBeDefined();

    const aliases = {
      '--c-nav-bg': '#f4c542',
      '--c-nav-brand': '#292415',
      '--c-nav-label': '#67510e',
      '--c-nav-text': '#403714',
      '--c-nav-hover-bg': '#e8b72c',
      '--c-nav-active-bg': '#dbaa1c',
      '--c-nav-active-text': '#201c0d',
      '--c-nav-border': '#d1a11b',
      '--c-nav-focus-ring': '#174ea6',
    } as const;

    for (const [name, value] of Object.entries(aliases)) {
      expect(scoped!.body).toMatch(new RegExp(`${name.replaceAll('-', '\\-')}\\s*:\\s*${value}`));
      expect(moduleCss.match(new RegExp(`${name.replaceAll('-', '\\-')}\\s*:`, 'g'))).toHaveLength(1);
    }
    expect(rules(moduleCss).some((rule) => rule.selectors.includes('.nonProduction'))).toBe(false);
  });

  it('applies the nav focus ring to exactly the four approved readers', () => {
    const focusRules = rules(moduleCss).filter((rule) =>
      rule.body.includes('outline-color: var(--c-nav-focus-ring)'),
    );
    expect(focusRules).toHaveLength(1);
    expect(new Set(focusRules[0]!.selectors)).toEqual(
      new Set([
        '.nonProduction .brand:focus-visible',
        '.nonProduction .link:focus-visible',
        '.nonProduction .collapseToggle:focus-visible',
        '.nonProduction .accountTrigger:focus-visible',
      ]),
    );
    expect(focusRules[0]!.selectors.join(',')).not.toMatch(/hamburger|topbarBrand|popover/i);
  });

  it('preserves production focus readers and the white topbar and overlays', () => {
    expect(ruleFor(indexCss, ':focus-visible').body).toContain(
      'outline: 2px solid var(--c-brand)',
    );
    expect(ruleFor(moduleCss, '.collapseToggle:focus-visible').body).toContain(
      'outline: 2px solid var(--c-focus-ring)',
    );
    expect(ruleFor(moduleCss, '.accountTrigger:focus-visible').body).toContain(
      'outline: 2px solid var(--c-focus-ring)',
    );
    expect(ruleFor(moduleCss, '.hamburger:focus-visible').body).toContain(
      'outline: 2px solid var(--c-focus-ring)',
    );
    expect(ruleFor(moduleCss, '.topbar').body).toContain('background: var(--c-surface)');
    expect(ruleFor(moduleCss, '.sidebar.collapsed .linkRow .linkLabel').body).toContain(
      'background: var(--c-surface)',
    );
    expect(ruleFor(moduleCss, '.popover').body).toContain('background: var(--c-surface)');
    expect(ruleFor(moduleCss, '.sidebar.collapsed .children').body).toContain(
      'background: var(--c-nav-bg)',
    );
  });

  it('keeps every locked text and focus pair above its contrast threshold', () => {
    expect(contrast('#67510e', '#f4c542')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#403714', '#f4c542')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#201c0d', '#dbaa1c')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#174ea6', '#f4c542')).toBeGreaterThanOrEqual(3);
    expect(contrast('#174ea6', '#dbaa1c')).toBeGreaterThanOrEqual(3);
  });
});
