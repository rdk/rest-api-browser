// The new UI (/plugins/servlet/restbrowser/next) in headless Edge/Chrome against a real Jira or Confluence (the one of
// src/test/product/product.sh): the catalog loads, search, an operation's form, Send, the response viewer, history,
// URL encoding of a path parameter, a deep link that prefills without sending, and no errors of the plugin.
//
//   node src/test/product/ui_next.js                            # http://localhost:2992/jira, admin/admin
//   RAB_PRODUCT=confluence node src/test/product/ui_next.js     # http://localhost:1992/confluence
//   RAB_URL=... RAB_USER=... RAB_PASSWORD=... RAB_BROWSER=... RAB_BROWSER_ARGS=... node src/test/product/ui_next.js
//
// Needs Node 22+ and Edge or Chrome. Exit code: 0 all passed, 1 a check failed, 2 not run.
const path = require('path');
const { launch, checker, sleep } = require('./cdp');

// per product: a public resource to search for, open and send, its answer, and a resource with a path parameter,
// which is sent with a value that needs URL encoding (a GET of something that cannot exist)
const PRODUCTS = {
    jira: { url: 'http://localhost:2992/jira', search: 'serverInfo', title: 'api/2/serverInfo', answer: /"baseUrl"|"version"/,
        templated: 'api/2/issue/{issueIdOrKey}', param: 'issueIdOrKey', wide: 'issue properties' },
    confluence: { url: 'http://localhost:1992/confluence', search: 'user current', title: 'api/user/current', answer: /"username"|"userKey"|"type"/,
        templated: 'api/content/{id}', param: 'id', wide: 'content property' },
};
const PRODUCT = process.env.RAB_PRODUCT || 'jira', P = PRODUCTS[PRODUCT];
if (!P) { console.log(`ui_next.js: RAB_PRODUCT is ${Object.keys(PRODUCTS).join(' or ')}, not ${PRODUCT}`); process.exit(2); }
const BASE = (process.env.RAB_URL || P.url).replace(/\/$/, '');
const USER = process.env.RAB_USER || 'admin', PASS = process.env.RAB_PASSWORD || 'admin';
const PAGE = BASE + '/plugins/servlet/restbrowser/next';
const CONTEXT = new URL(BASE).pathname.replace(/\/$/, '');
const SHOTS = path.join(__dirname, 'shots');
const ODD = 'no such?#%&$&', ODD_ENCODED = 'no%20such%3F%23%25%26%24%26';

(async () => {
    const c = checker();
    let b;
    try {
        b = await launch({ user: USER, password: PASS });
    } catch (e) {
        console.log('ui_next.js: ' + e.message);
        process.exit(2);
    }
    const q = s => JSON.stringify(s);
    const text = sel => b.evaluate(`(document.querySelector(${q(sel)}) || {}).textContent || ''`);
    const type = (sel, value) => b.evaluate(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return false;
        const setter = Object.getOwnPropertyDescriptor(e.constructor.prototype, 'value').set; setter.call(e, ${q(value)});
        e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const click = sel => b.evaluate(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return false; e.click(); return true; })()`);
    const pressAltP = async () => {
        const base = { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80, modifiers: 1 };
        await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
        await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    };
    const clickAt = async (x, y) => {
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    const openOp = async (search, title, method = 'GET') => {
        const row = `[data-testid=op][data-method=${method}][data-path=${q(title)}]`;
        await type('[data-testid=search]', search);
        await b.waitFor(`!!document.querySelector(${q(row)})`, 10000);
        if (!await click(row)) return false;
        return b.waitFor(`(document.querySelector('[data-testid=operation-path]') || {}).textContent === ${q(title)}`, 10000);
    };
    try {
        const t0 = Date.now();
        await b.navigate(PAGE);
        c.check('the page opens and the app renders', await b.waitFor('!!document.querySelector(".rab-n [data-testid=search]")', 60000),
            await b.evaluate('location.href + " " + document.title'));
        const loaded = await b.waitFor(`document.querySelectorAll('[data-testid=op], [data-testid=module]').length > 0
            && /operations/.test((document.querySelector('[data-testid=status]') || {}).textContent || '')`, 120000);
        const status = await text('[data-testid=status]');
        c.check('the catalog loads into the list', loaded, status);
        console.log(`Catalog: ${status.trim()} (${Date.now() - t0} ms to a usable list)`);
        await b.shot(path.join(SHOTS, `${PRODUCT}-next-1-browse.png`));

        // the header: the brand opens the project on GitHub, the version its releases (both in a new tab), Classic UI
        const header = await b.evaluate(`(() => {
            const top = document.querySelector('.rab-n-topbar');
            const attrs = sel => { const e = top.querySelector(sel); return e && { text: e.textContent.trim(), href: e.getAttribute('href'), target: e.target }; };
            return { brand: attrs('[data-testid=brand]'), version: attrs('[data-testid=version]'), classic: attrs('[data-testid=classic-link]') };
        })()`);
        const site = await b.evaluate(`(() => { const e = document.querySelector('.rab-n-topbar [data-testid=site]');
            return e && { text: e.textContent, href: e.getAttribute('href'), center: Math.round(e.getBoundingClientRect().left + e.getBoundingClientRect().width / 2),
                bar: Math.round(document.querySelector('.rab-n-topbar').getBoundingClientRect().left + document.querySelector('.rab-n-topbar').getBoundingClientRect().width / 2) }; })()`);
        c.check(`the header shows the product's base URL in the middle, without the protocol (${site && site.text})`,
            !!site && site.text.length > 0 && !/^[a-z]+:\/\//i.test(site.text) && /^https?:\/\//.test(site.href)
            && site.href.replace(/^https?:\/\//, '').replace(/\/$/, '') === site.text && Math.abs(site.center - site.bar) <= 2, site);
        c.check('the header links the brand to GitHub, the version to its releases, and the classic UI',
            !!header.brand && /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(header.brand.href) && header.brand.target === '_blank'
            && !!header.version && /^v\d/.test(header.version.text) && /\/releases$/.test(header.version.href) && header.version.target === '_blank'
            && !!header.classic && /\/plugins\/servlet\/restbrowser$/.test(header.classic.href), header);
        const brand = await b.evaluate(`(() => { const r = document.querySelector('[data-testid=brand]').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brand.x, y: brand.y });
        const about = await b.waitFor(`(() => { const e = document.querySelector('[data-testid=about]'); const st = e && getComputedStyle(e);
            return !!st && st.visibility === 'visible' && Number(st.opacity) > 0.95; })()`, 3000);
        c.check('resting on the brand shows the tooltip about the project', about,
            await b.evaluate(`(document.querySelector('[data-testid=about]') || {}).textContent || 'none'`));
        await b.shot(path.join(SHOTS, `${PRODUCT}-next-6-about.png`));
        const aboutShown = `(() => { const e = document.querySelector('[data-testid=about]'); return !!e && getComputedStyle(e).visibility === 'visible'; })()`;
        await pressAltP();
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brand.x + 700, y: brand.y + 300 });
        await sleep(500);
        const aboutPinned = await b.evaluate(aboutShown);
        await clickAt(brand.x + 700, brand.y + 300);
        await sleep(400);
        const aboutGone = !await b.evaluate(aboutShown);
        c.check('Alt+P pins the tooltip about the project; a click outside hides it', aboutPinned && aboutGone, { aboutPinned, aboutGone });

        // the page is the app: no product footer, nothing to scroll
        const page = await b.evaluate(`(() => { const shown = sel => { const e = document.querySelector(sel); return e ? getComputedStyle(e).display : 'absent'; };
            return { header: shown('#header'), footer: shown('#footer'), overflow: document.documentElement.scrollHeight - innerHeight,
                appTop: Math.round(document.querySelector('.rab-n').getBoundingClientRect().top) }; })()`);
        c.check(`the product's header and footer are hidden and the page does not scroll (${page.overflow} px more)`,
            ['none', 'absent'].includes(page.header) && ['none', 'absent'].includes(page.footer) && page.overflow <= 4, page);

        // search: a flat, ranked list
        const searchStart = Date.now();
        await type('[data-testid=search]', P.search);
        const found = await b.waitFor(`!!document.querySelector('[data-testid=op][data-path=${q(P.title)}]')`, 5000);
        c.check(`searching "${P.search}" lists ${P.title}`, found, await b.evaluate(
            `[...document.querySelectorAll('[data-testid=op]')].slice(0, 5).map(e => e.dataset.path)`));
        const marked = await b.evaluate(`[...document.querySelectorAll('[data-testid=op][data-path=${q(P.title)}] .rab-n-pp-hit')].map(e => e.textContent)`);
        c.check('the search words are marked in the path, the module part told apart, the first word bold',
            marked.length > 0 && marked.every(m => P.search.toLowerCase().split(' ').some(w => m.toLowerCase().includes(w) || w.includes(m.toLowerCase())))
            && await b.evaluate(`!!document.querySelector('[data-testid=op][data-path=${q(P.title)}] .rab-n-pp-mod')`)
            && await b.evaluate(`getComputedStyle(document.querySelector('[data-testid=op][data-path=${q(P.title)}] .rab-n-pp-lead')).fontWeight >= 600`), marked);

        // the hover card of a row: the pointer rests on the row, the card spells out the app and the access
        const rect = await b.evaluate(`(() => { const e = document.querySelector('[data-testid=op][data-path=${q(P.title)}]');
            const r = e.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
        const carded = await b.waitFor(`/App/.test((document.querySelector('[data-testid=row-card]') || {}).textContent || '')
            && /Access/.test(document.querySelector('[data-testid=row-card]').textContent)`, 3000);
        c.check('resting on a row opens its card with the app and the access', carded,
            await b.evaluate(`(document.querySelector('[data-testid=row-card]') || {}).textContent || 'no card'`));
        await b.shot(path.join(SHOTS, `${PRODUCT}-next-3-card.png`));
        await pressAltP();
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + 1200, y: rect.y + 300 });
        await sleep(500);
        const cardPinned = await b.evaluate(`!!document.querySelector('[data-testid=row-card].pinned')`);
        await clickAt(rect.x + 1200, rect.y + 300);
        await sleep(300);
        const cardGone = await b.evaluate(`!document.querySelector('[data-testid=row-card]')`);
        c.check('Alt+P pins a row\'s card; a click outside hides it', cardPinned && cardGone, { cardPinned, cardGone });
        console.log(`Search answered in ${Date.now() - searchStart} ms (including the poll)`);

        // the operation: form, live URL, send, response
        c.check(`opening ${P.title} shows its form`, await openOp(P.search, P.title));
        const url = await text('[data-testid=live-url]');
        c.check('the live URL ends with the operation path', url.endsWith('/rest/' + P.title), url);
        const idle = await b.evaluate(`(() => { const e = document.querySelector('[data-testid=response-idle]');
            return e ? Math.round(e.getBoundingClientRect().height) : -1; })()`);
        c.check(`before a response, the response area is a slim line (${idle} px)`, idle > 0 && idle < 48, idle);
        await click('[data-testid=send]');
        const answered = await b.waitFor(`${P.answer}.test((document.querySelector('[data-testid=response]') || {}).textContent || '')`, 20000);
        c.check(`Send shows the product's answer (status ${(await text('[data-testid=response-status]')).trim()})`, answered,
            (await text('[data-testid=response]')).slice(0, 200));
        await b.shot(path.join(SHOTS, `${PRODUCT}-next-2-response.png`));
        const numbers = await b.evaluate(`document.querySelectorAll('[data-testid=response] .rab-n-gutter').length`);
        await b.evaluate(`([...document.querySelectorAll('[data-testid=response] [role=tab]')].find(t => /^Headers/.test(t.textContent)) || {}).click?.(), true`);
        await b.waitFor(`!!document.querySelector('[data-testid=request-header]')`, 3000);
        const sentHeaders = await b.evaluate(`[...document.querySelectorAll('[data-testid=request-header]')].map(e => e.textContent)`);
        c.check('Pretty shows no line numbers; Headers lists the request\'s headers before the response\'s',
            numbers === 0 && sentHeaders.some(h => /^accept:/i.test(h)), { numbers, sentHeaders });
        await b.evaluate(`([...document.querySelectorAll('[data-testid=response] [role=tab]')].find(t => /^Pretty/.test(t.textContent)) || {}).click?.(), true`);
        c.check('the History tab lists the request', await b.waitFor(`/History \\([1-9]/.test(document.body.textContent)`, 5000));

        // a path parameter's value is URL-encoded; the request is a GET of something that cannot exist
        let templatedKey = null;
        if (await openOp(P.templated.split('/').slice(-2).join(' ').replace(/[{}]/g, ''), P.templated)) {
            templatedKey = await b.evaluate(`new URLSearchParams(location.search).get('op')`);
            const mark = () => b.evaluate(`(() => { const i = document.querySelector('input[name=${P.param}]');
                const m = i && i.parentElement.querySelector('[data-testid=check]'); return m ? m.dataset.state : 'none'; })()`);
            const colorOf = sel => b.evaluate(`(() => { const e = document.querySelector(${q(sel)}); return e ? getComputedStyle(e).color : null; })()`);
            const templateColor = await colorOf('[data-testid=live-url] .rab-n-pp-param');
            const empty = { mark: await mark(), tab: await b.evaluate(`!!document.querySelector('[data-testid=params-warn]')`),
                send: await b.evaluate(`document.querySelector('[data-testid=send]').disabled`) };
            await b.shot(path.join(SHOTS, `${PRODUCT}-next-5-form.png`));
            await type(`input[name=${q(P.param)}]`, ODD);
            await sleep(100);
            const filled = { mark: await mark(), tab: await b.evaluate(`!!document.querySelector('[data-testid=params-warn]')`) };
            c.check('an empty required value shows a warning sign, a filled one a check', empty.mark === 'warn' && empty.tab && empty.send
                && filled.mark === 'ok' && !filled.tab, { empty, filled });
            const value = { text: await text('[data-testid=live-url] .rab-n-pp-value'), color: await colorOf('[data-testid=live-url] .rab-n-pp-value') };
            const colors = { templateColor, value };
            if (await b.evaluate(`!!document.querySelector('input[name=expand]')`)) {
                await type('input[name=expand]', 'names');
                await sleep(100);
                colors.query = { text: await text('[data-testid=live-url] .rab-n-pp-qvalue'), color: await colorOf('[data-testid=live-url] .rab-n-pp-qvalue'),
                    pill: await colorOf('.rab-n-in-query') };
            }
            c.check('in the URL a path value keeps the color of its template, a query value the color of the query parameters',
                !!templateColor && value.text === ODD_ENCODED && value.color === templateColor
                && (!colors.query || (colors.query.text === 'names' && colors.query.color === colors.query.pill)), colors);
            const live = await text('[data-testid=live-url]');
            c.check('the live URL carries the path value URL-encoded', live.includes('/' + ODD_ENCODED), live);
            const method = await b.evaluate(`(document.querySelector('[data-testid=send]') || {}).textContent || ''`);
            if (/GET/.test(method)) {
                await click('[data-testid=send]');
                const st = await b.waitFor(`/\\d{3}/.test((document.querySelector('[data-testid=response-status]') || {}).textContent || '')`, 20000);
                c.check('the GET with the odd value gets an answer', st,
                    (await text('[data-testid=response-status]')).trim() || (await text('.rab-n-response')).slice(0, 200));
            }
            // undo, redo and reset: the steps are the path value, then the query value (when the form has one)
            const val = n => b.evaluate(`(document.querySelector('input[name=${n}]') || {}).value`);
            const form = async () => ({ param: await val(P.param), expand: colors.query ? await val('expand') : undefined });
            const tool = async id => { await click(`[data-testid=form-${id}]`); await sleep(150); return form(); };
            const steps = {};
            if (colors.query) steps.undoQuery = await tool('undo');
            steps.undoPath = await tool('undo');
            steps.redo = await tool('redo');
            steps.reset = await tool('reset');
            steps.undoReset = await tool('undo');
            c.check('undo, redo and reset change the form step by step',
                (!colors.query || (steps.undoQuery.expand === '' && steps.undoQuery.param === ODD))
                && steps.undoPath.param === '' && steps.redo.param === ODD && steps.reset.param === '' && (!colors.query || steps.reset.expand === '')
                && steps.undoReset.param === ODD, steps);
        } else {
            console.log(`SKIP the path parameter: ${P.templated} is not in the list`);
        }

        // the keyboard: / focuses the search, arrows move through the results, Enter opens one
        const KEYS = { '/': [191, 'Slash'], ArrowDown: [40, 'ArrowDown'], ArrowRight: [39, 'ArrowRight'], Enter: [13, 'Enter'], Escape: [27, 'Escape'] };
        const press = async key => {
            const [code, name] = KEYS[key];
            const base = { key, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
            await b.send('Input.dispatchKeyEvent', { type: key === '/' ? 'keyDown' : 'rawKeyDown', ...base, ...(key === '/' ? { text: '/' } : {}) });
            await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        };
        await b.evaluate(`document.activeElement && document.activeElement.blur(), true`);
        await press('/');
        const focused = await b.evaluate(`document.activeElement === document.querySelector('[data-testid=search]')`);
        await type('[data-testid=search]', P.search);
        await sleep(400);
        await press('ArrowDown');
        await press('Enter');
        const opened = await b.waitFor(`!!document.querySelector('[data-testid=operation-path]')
            && document.querySelector('[data-testid=op].selected') !== null`, 5000);
        c.check('the keyboard: / focuses the search, ArrowDown and Enter open the first result', focused && opened, { focused, opened });

        // a wide list shows whole paths (the divider moves with the arrow keys)
        await type('[data-testid=search]', P.wide);
        await sleep(400);
        await b.evaluate(`document.querySelector('.rab-n-vsplit').focus(), true`);
        for (let i = 0; i < 25; i++) await press('ArrowRight');
        await sleep(200);
        const wide = await b.evaluate(`(() => {
            const side = document.querySelector('.rab-n-side').getBoundingClientRect().width;
            const rows = [...document.querySelectorAll('.rab-n-op-path')];
            const cut = rows.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent);
            const longest = rows.map(e => e.textContent).sort((a, b) => b.length - a.length)[0] || '';
            return { side: Math.round(side), rows: rows.length, cut, longest };
        })()`);
        c.check(`a wide list (${wide.side} px) shows whole paths, the longest ${wide.longest.length} characters`,
            wide.rows > 0 && wide.side > 600 && wide.cut.length === 0, wide);

        // the header's menu: Classic UI, rebuilding for system administrators; "Reset the layout" narrows the list again
        await click('[data-testid=menu-button]');
        const menu = await b.waitFor(`!!document.querySelector('[data-testid=menu] [data-testid=report-issue][href*="github.com/"][href*="/issues/new"][target=_blank]')`, 3000);
        const items = await b.evaluate(`[...document.querySelectorAll('[data-testid=menu] [role=menuitem]')].map(e => e.querySelector('.rab-n-menu-label').textContent)`);
        await b.shot(path.join(SHOTS, `${PRODUCT}-next-4-menu.png`));
        await press('Escape');
        const closed = await b.waitFor(`!document.querySelector('[data-testid=menu]')`, 2000);
        c.check('the menu opens with "Report an issue…" (GitHub, in a new tab) and closes with Escape', menu && closed, { items, closed });
        await click('[data-testid=menu-button]');
        await b.evaluate(`([...document.querySelectorAll('[data-testid=menu] [role=menuitem]')].find(e => /Reset the layout/.test(e.textContent)) || {}).click?.(), true`);
        const reset = await b.waitFor(`Math.round(document.querySelector('.rab-n-side').getBoundingClientRect().width) === 430`, 2000);
        c.check('"Reset the layout" brings the list back to its default width', reset,
            await b.evaluate(`document.querySelector('.rab-n-side').getBoundingClientRect().width`));

        // every operation's ticks agree with the catalog: "/" lists them all; the list is scrolled through
        await type('[data-testid=search]', '/');
        await sleep(600);
        const TICKS = `
            const cat = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/catalog', { credentials: 'same-origin' })).json();
            const idx = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/catalog/index/' + cat.hash, { credentials: 'same-origin' })).json();
            const mods = new Map(cat.modules.map(m => [m.id, m]));
            const kind = m => m.stability === 'supported' ? ['supported'] : m.stability === 'app' || m.origin === 'user' ? ['app']
                : m.origin === 'bundled' ? ['bundled'] : [];
            const ACCESS = { UnrestrictedAccess: 'open', AnonymousSiteAccess: 'open', AnonymousAllowed: 'open',
                UnlicensedSiteAccess: 'unlicensed', AdminOnly: 'admin', SystemAdminOnly: 'sysadmin' };
            const list = document.querySelector('.rab-n-vlist');
            const tones = row => [...row.querySelectorAll('.rab-n-tick')].map(t => [...t.classList].find(c => c.startsWith('rab-n-tone-')).slice(11)).join(' ');
            const scan = async sel => {
                const seen = new Map();
                for (let top = 0; ; top += list.clientHeight) {
                    list.scrollTop = top;
                    await new Promise(r => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 120); });
                    for (const row of list.querySelectorAll(sel)) seen.set(row.dataset.id, tones(row));
                    if (top + list.clientHeight >= list.scrollHeight) break;
                }
                list.scrollTop = 0;
                return seen;
            };`;
        const ticks = await b.evaluate(`(async () => { ${TICKS}
            const ops = new Map(idx.operations.map(o => [o.key, o]));
            const seen = await scan('[data-testid=op]');
            const wrong = [];
            const counts = {};
            for (const [id, got] of seen) {
                const op = ops.get(id);
                const want = op ? [...kind(mods.get(op.module)), ...(op.deprecated ? ['deprecated'] : []), ...(ACCESS[op.access] ? [ACCESS[op.access]] : [])].join(' ') : '?';
                if (got !== want) wrong.push({ id, got, want });
                for (const t of got.split(' ').filter(Boolean)) counts[t] = (counts[t] || 0) + 1;
            }
            return { listed: seen.size, total: idx.operations.length, wrong: wrong.length, examples: wrong.slice(0, 5), counts };
        })()`);
        c.check(`every operation's ticks agree with the catalog (${ticks.listed} rows: ${JSON.stringify(ticks.counts)})`,
            ticks.listed === ticks.total && ticks.wrong === 0, ticks);

        // the module button folds every module, the modules' ticks agree with the catalog, and it unfolds them again
        await type('[data-testid=search]', '');
        await sleep(400);
        const folded = await click('[data-testid=toggle-modules][data-state=expanded]')
            && await b.waitFor(`!!document.querySelector('[data-testid=toggle-modules][data-state=collapsed]') && !document.querySelector('[data-testid=op]')`, 3000);
        const moduleTicks = await b.evaluate(`(async () => { ${TICKS}
            const seen = await scan('[data-testid=module]');
            const wrong = [];
            for (const [id, got] of seen) {
                const want = kind(mods.get(id.slice('module:'.length)) || {}).join(' ');
                if (got !== want) wrong.push({ id, got, want });
            }
            // a module without operations is not listed (unless it failed or is still being read)
            const withOps = new Set(idx.operations.map(o => o.module));
            const total = cat.modules.filter(m => withOps.has(m.id) || m.state !== 'ok').length;
            return { listed: seen.size, total, wrong: wrong.length, examples: wrong.slice(0, 5) };
        })()`);
        c.check(`every module's tick agrees with the catalog (${moduleTicks.listed} modules)`,
            moduleTicks.listed === moduleTicks.total && moduleTicks.wrong === 0, moduleTicks);
        const unfolded = await click('[data-testid=toggle-modules][data-state=collapsed]')
            && await b.waitFor(`!!document.querySelector('[data-testid=toggle-modules][data-state=expanded]') && !!document.querySelector('[data-testid=op]')`, 3000);
        c.check('the small button in the list folds and unfolds every module', folded && unfolded, { folded, unfolded });

        // supported only narrows the list
        await type('[data-testid=search]', '');
        const before = await b.evaluate(`(document.querySelector('[data-testid=status]') || {}).textContent || ''`);
        await click('[data-testid=supported-only]');
        await sleep(300);
        const after = await text('[data-testid=status]');
        c.check('"Supported only" narrows the operations', /of/.test(after) && after !== before, { before, after });
        await click('[data-testid=supported-only]');

        // a deep link fills the form and sends nothing (the operation with the path parameter, opened above)
        const key = templatedKey || await b.evaluate(`new URLSearchParams(location.search).get('op')`);
        await b.navigate(PAGE + '?op=' + encodeURIComponent(key) + '&path.' + encodeURIComponent(P.param) + '=DEEP-1');
        const prefilled = await b.waitFor(`(document.querySelector('input[name=${P.param}]') || {}).value === 'DEEP-1'`, 60000);
        const sent = await b.evaluate(`!!document.querySelector('[data-testid=response]')`);
        c.check('a deep link opens the operation with its values, without sending', prefilled && !sent, { prefilled, sent });

        // errors
        const own = b.exceptions.filter(e => /next\.js|rest-api-browser|restbrowser/i.test(e));
        c.check('no JavaScript exception from the new UI', own.length === 0, own);
        const ownFailed = b.failedRequests.filter(u => /restbrowser|rest-api-browser/i.test(u));
        c.check('no failed request for the plugin\'s own resources', ownFailed.length === 0, ownFailed.slice(0, 5));
        b.failedRequests.filter(u => !ownFailed.includes(u) && !/no%20such/.test(u)).forEach(u => console.log('WARN failed request: ' + u));
        console.log(`Screenshots: ${SHOTS}`);
    } catch (e) {
        c.check('the browser run completed', false, String(e && e.stack || e));
    } finally {
        await b.close();
    }
    process.exit(c.finish());
})();
