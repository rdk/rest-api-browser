import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readStyle = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('ui/styles', () => {
  it('hides modal title-bar tabstrip scrollbars and avoids negative-bottom overhang', () => {
    const css = stripComments(readStyle('java.css'));

    const tabstrip = css.match(/\.rab-n-modal-tabstrip\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(tabstrip).toMatch(/overflow-x:\s*auto\b/);
    expect(tabstrip).toMatch(/overflow-y:\s*hidden\b/);
    expect(tabstrip).toMatch(/scrollbar-width:\s*none\b/);
    expect(tabstrip).not.toMatch(/scrollbar-width:\s*thin\b/);

    const webkitBar = css.match(/\.rab-n-modal-tabstrip::-webkit-scrollbar\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(webkitBar).toMatch(/display:\s*none\b/);

    const activeAfter = css.match(/\.rab-n-modal-tab\.on::after\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(activeAfter).not.toMatch(/bottom:\s*-/);
  });

  it('keeps request and response tabbars scrollbar-free without negative overhang', () => {
    const opCss = stripComments(readStyle('operation.css'));
    const opTabs = opCss.match(/\.rab-n-tabbar > \.rab-n-tabs\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(opTabs).toMatch(/overflow-x:\s*auto\b/);
    expect(opTabs).toMatch(/overflow-y:\s*hidden\b/);
    expect(opTabs).toMatch(/scrollbar-width:\s*none\b/);
    expect(opCss).toMatch(/\.rab-n-tabbar > \.rab-n-tabs::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
    const opAfter = opCss.match(/\.rab-n-tab\.on::after,\s*\.rab-n-tab\[aria-selected="true"\]::after\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(opAfter).not.toMatch(/bottom:\s*-/);

    const resCss = stripComments(readStyle('response.css'));
    const resTabs = [...resCss.matchAll(/\.rab-n-tabbar-response > \.rab-n-tabs\s*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    expect(resTabs).toMatch(/overflow-x:\s*auto\b/);
    expect(resTabs).toMatch(/overflow-y:\s*hidden\b/);
    expect(resTabs).toMatch(/scrollbar-width:\s*none\b/);
    expect(resCss).toMatch(/\.rab-n-tabbar-response > \.rab-n-tabs::-webkit-scrollbar\s*\{[^}]*display:\s*none/);

    const layoutCss = stripComments(readStyle('layout.css'));
    expect(layoutCss).toMatch(/grid-template-columns:\s*minmax\(max-content,\s*1fr\)\s+minmax\(0,\s*auto\)\s+minmax\(max-content,\s*1fr\)/);

    const statesCss = stripComments(readStyle('states.css'));
    expect(statesCss).toMatch(/\.rab-n-class-tip/);
    expect(statesCss).toMatch(/\.rab-n-uitip/);
  });

  it('keeps all stylesheets unlayered so RAB rules beat host AUI styles', () => {
    const indexCss = readStyle('index.css');
    const imports = [...indexCss.matchAll(/@import\s+['"]\.\/([^'"]+\.css)['"]\s*;/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThanOrEqual(10);

    for (const file of ['index.css', ...imports]) {
      const stripped = stripComments(readStyle(file));
      expect(stripped, `${file} must not declare @layer`).not.toMatch(/@layer\b/);
    }
  });

  it('keeps navy dark-mode contrast tokens, non-hardcoded brand mark, and visible modal find input', () => {
    const tokensCss = stripComments(readStyle('tokens.css'));
    expect(tokensCss).toMatch(/--rab-border-bold:/);
    expect(tokensCss).toMatch(/--rab-raised-hover:/);

    const skinsCss = stripComments(readStyle('skins.css'));
    expect(skinsCss).toMatch(/\[data-color-mode="dark"\]\s*\.rab-n\[data-skin="navy"\][^}]*--rab-on-brand:\s*var\(--rab-on-bold\)/);
    expect(skinsCss).not.toMatch(/\.rab-n\[data-skin="navy"\]\s+\.rab-n-brand-mark\s*\{[^}]*#[0-9a-f]/i);

    const javaCss = stripComments(readStyle('java.css'));
    expect(javaCss).toMatch(/\.rab-n-modal-bar\s+\.rab-n-find\s+input\s*\{[^}]*border-color:\s*var\(--rab-border\)/);
  });
});
