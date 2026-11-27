// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetSource } from '../../core/details';
import { module, op } from '../../core/fixtures';
import { clearEscapeStack } from '../../lib/overlay';
import { createLineTracker, SourceTabPane } from './SourceTabPane';

afterEach(() => {
  render(null, document.body);
  clearEscapeStack();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

describe('ui/source/CodeIntelPanels', () => {
  it('switches panels in SourceTabPane, triggers imps/callers/grep/resources, and opens resource preview', async () => {
    const mod = module('jira:api2', 'api/2', { plugin: { key: 'com.example.plugin', name: 'Example Plugin' } });
    const issueOp = op('jira:api2', 'GET', 'issue/{id}');
    const modulesById = new Map([[mod.id, mod]]);

    const query = {
      op: issueOp.key,
      classCandidates: ['com.example.IssueResource'],
      fromBundle: 42,
      scope: 'class' as const,
      decompiler: 'cfr' as const,
    };
    forgetSource(query, '/jira');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/catalog/details/source') || url.includes('/code/source')) {
        return new Response(JSON.stringify({
          format: 1,
          key: issueOp.key,
          class: 'com.example.IssueResource',
          decompiler: 'CFR 0.152',
          decompilerId: 'cfr',
          bundleId: 42,
          source: 'public class IssueResource {\n  public String getIssue() { return "ok"; }\n}\n',
          refs: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/code/implementations')) {
        return new Response(JSON.stringify({
          format: 1,
          target: 'com.example.IssueResource',
          kind: 'class',
          bundleId: 42,
          scannedBundles: 1,
          truncated: false,
          elapsedMs: 4,
          serviceCount: 1,
          osgiServices: [
            { serviceId: 9, bundleId: 42, plugin: 'com.example.plugin', beanName: 'issueSvc', ranking: 0, objectClass: ['com.example.IssueService'] },
          ],
          implementationCount: 1,
          implementations: [
            { class: 'com.example.DefaultIssueImpl', simpleName: 'DefaultIssueImpl', kind: 'class', abstract: false, bundleId: 42, plugin: 'com.example.plugin', via: 'implements' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/code/callers')) {
        return new Response(JSON.stringify({
          format: 1,
          target: 'com.example.IssueResource',
          bundleId: 42,
          count: 1,
          scannedClasses: 12,
          scannedBundles: 1,
          truncated: false,
          elapsedMs: 5,
          results: [
            { class: 'com.example.IssueCaller', simpleName: 'IssueCaller', bundleId: 42, plugin: 'com.example.plugin', calls: ['render() -> getIssue()'] },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/code/grep')) {
        return new Response(JSON.stringify({
          format: 1,
          query: 'restbrowser',
          caseSensitive: false,
          includeUtf8: true,
          count: 1,
          scannedClasses: 10,
          scannedBundles: 1,
          truncated: false,
          elapsedMs: 6,
          results: [
            { class: 'com.example.GrepHit', simpleName: 'GrepHit', bundleId: 42, plugin: 'com.example.plugin', matches: ['utf8: restbrowser'] },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/code/resource') && url.includes('path=')) {
        return new Response(JSON.stringify({
          format: 1,
          bundleId: 42,
          path: 'atlassian-plugin.xml',
          kind: 'xml',
          bytes: 41,
          totalLines: 1,
          startLine: 1,
          endLine: 1,
          truncated: false,
          content: '<atlassian-plugin key="com.example.plugin"/>',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/code/resource')) {
        return new Response(JSON.stringify({
          format: 1,
          bundleId: 42,
          count: 1,
          truncated: false,
          entries: [{ path: 'atlassian-plugin.xml', kind: 'xml' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const onOpenClass = vi.fn();
    render(
      <div class="rab-n">
        <SourceTabPane
          baseUrl="/jira"
          tab={{
            uid: 'u1',
            id: 'com.example.IssueResource',
            label: 'IssueResource',
            candidates: ['com.example.IssueResource'],
            fromBundle: 42,
            opKey: issueOp.key,
          }}
          tabButtonId="tab-1"
          decompiler="cfr"
          onDecompiler={() => undefined}
          pretty={false}
          onPretty={() => undefined}
          onOpenClass={onOpenClass}
          onResolveTab={() => undefined}
          showOutline
          onToggleOutline={() => undefined}
          outlineWidth={240}
          onOutlineWidth={() => undefined}
          operations={[issueOp]}
          modulesById={modulesById}
          onMeta={() => undefined}
          lineTracker={createLineTracker()}
        />
      </div>,
      document.body,
    );
    await tick(40);

    expect(document.querySelector('[data-testid=source-panel-tabs]')).not.toBeNull();
    expect(document.querySelector('[data-testid=dialog-source-code]')).not.toBeNull();

    // Switch to Implementations
    (document.querySelector('[data-testid=source-panel-implementations]') as HTMLButtonElement).click();
    await tick(40);
    expect(document.querySelector('[data-testid=implementations-panel]')?.textContent).toContain('DefaultIssueImpl');
    const implBtn = document.querySelector('[data-testid=implementations-panel] button.rab-n-intel-item') as HTMLButtonElement;
    implBtn.click();
    expect(onOpenClass).toHaveBeenCalledWith(expect.objectContaining({ target: 'com.example.DefaultIssueImpl', fromBundle: 42 }));

    // Switch to Callers
    (document.querySelector('[data-testid=source-panel-callers]') as HTMLButtonElement).click();
    await tick(40);
    expect(document.querySelector('[data-testid=callers-panel]')?.textContent).toContain('IssueCaller');

    // Switch to Grep and run search
    (document.querySelector('[data-testid=source-panel-grep]') as HTMLButtonElement).click();
    await tick(20);
    const grepInput = document.querySelector('[data-testid=grep-query-input]') as HTMLInputElement;
    grepInput.value = 'restbrowser';
    grepInput.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(10);
    (document.querySelector('[data-testid=grep-submit]') as HTMLButtonElement).click();
    await tick(40);
    expect(document.querySelector('[data-testid=grep-panel]')?.textContent).toContain('GrepHit');

    // Switch to Files and open preview, then Escape back to Java source
    (document.querySelector('[data-testid=source-panel-resources]') as HTMLButtonElement).click();
    await tick(40);
    const fileItem = document.querySelector('[data-testid=bundle-resource-item]') as HTMLButtonElement;
    expect(fileItem).not.toBeNull();
    fileItem.click();
    await tick(40);
    const preview = document.querySelector('[data-testid=bundle-resource-preview]');
    expect(preview?.textContent).toContain('<atlassian-plugin key="com.example.plugin"/>');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(20);
    expect(document.querySelector('[data-testid=bundle-resource-preview]')).toBeNull();
    expect(document.querySelector('[data-testid=dialog-source-code]')).not.toBeNull();
  });
});
