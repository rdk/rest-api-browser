// The new UI (/plugins/servlet/rest-api-browser) in headless Edge/Chrome against a real Jira or Confluence (the one of
// src/test/product/product.sh): the catalog loads, search, an operation's form, Send, the response viewer, history,
// URL encoding of a path parameter, a deep link that prefills without sending, and no errors of the plugin.
//
//   node src/test/product/ui_next.js                            # http://localhost:2992/jira, admin/admin
//   RAB_PRODUCT=confluence node src/test/product/ui_next.js     # http://localhost:1992/confluence
//   RAB_URL=... RAB_USER=... RAB_PASSWORD=... RAB_BROWSER=... RAB_BROWSER_ARGS=... node src/test/product/ui_next.js
//
// Needs Node 22+ and Edge or Chrome. Exit code: 0 all passed, 1 a check failed, 2 not run.
const path = require('path');
const fs = require('fs');
const os = require('os');
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
const PAGE = BASE + '/plugins/servlet/rest-api-browser';
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
    const KEYS = { '/': [191, 'Slash'], ArrowDown: [40, 'ArrowDown'], ArrowRight: [39, 'ArrowRight'], Enter: [13, 'Enter'], Escape: [27, 'Escape'] };
    const press = async key => {
        const [code, name] = KEYS[key];
        const base = { key, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
        await b.send('Input.dispatchKeyEvent', { type: key === '/' ? 'keyDown' : 'rawKeyDown', ...base, ...(key === '/' ? { text: '/' } : {}) });
        await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
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

        // the header: the brand pins the about tooltip (containing the GitHub link), the version links to releases, Classic UI
        const header = await b.evaluate(`(() => {
            const top = document.querySelector('.rab-n-topbar');
            const attrs = sel => { const e = top.querySelector(sel); return e && { tag: e.tagName, text: e.textContent.trim(), href: e.getAttribute('href'), target: e.target }; };
            return { brand: attrs('[data-testid=brand]'), aboutLink: attrs('[data-testid=about] a'), version: attrs('[data-testid=version]'), classic: attrs('[data-testid=classic-link]') };
        })()`);
        const site = await b.evaluate(`(() => { const e = document.querySelector('.rab-n-topbar [data-testid=site]');
            return e && { text: e.textContent, href: e.getAttribute('href'), target: e.target, center: Math.round(e.getBoundingClientRect().left + e.getBoundingClientRect().width / 2),
                bar: Math.round(document.querySelector('.rab-n-topbar').getBoundingClientRect().left + document.querySelector('.rab-n-topbar').getBoundingClientRect().width / 2) }; })()`);
        c.check(`the header shows the product's base URL in the middle, without the protocol (${site && site.text})`,
            !!site && site.text.length > 0 && !/^[a-z]+:\/\//i.test(site.text) && /^https?:\/\//.test(site.href)
            && site.href.replace(/^https?:\/\//, '').replace(/\/$/, '') === site.text && Math.abs(site.center - site.bar) <= 2
            && site.target === '_blank', site);
        c.check('the header shows the brand button (GitHub link in About tooltip), version to releases, and classic UI',
            !!header.brand && header.brand.tag === 'BUTTON' && !header.brand.href
            && !!header.aboutLink && /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(header.aboutLink.href) && header.aboutLink.target === '_blank'
            && !!header.version && /^v\d/.test(header.version.text) && /\/releases$/.test(header.version.href) && header.version.target === '_blank'
            && !!header.classic && /\/plugins\/servlet\/restbrowser$/.test(header.classic.href) && header.classic.target === '_blank', header);
        const brand = await b.evaluate(`(() => { const r = document.querySelector('[data-testid=brand]').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brand.x, y: brand.y });
        const about = await b.waitFor(`(() => { const e = document.querySelector('[data-testid=about]'); const st = e && getComputedStyle(e);
            return !!st && st.visibility === 'visible' && Number(st.opacity) > 0.95; })()`, 3000);
        c.check('resting on the brand shows the tooltip about the project', about,
            await b.evaluate(`(document.querySelector('[data-testid=about]') || {}).textContent || 'none'`));
        await b.shot(path.join(SHOTS, `${PRODUCT}-next-6-about.png`));
        const aboutShown = `(() => { const e = document.querySelector('[data-testid=about]'); return !!e && getComputedStyle(e).visibility === 'visible'; })()`;
        await clickAt(brand.x, brand.y);
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brand.x + 700, y: brand.y + 300 });
        await sleep(500);
        const aboutPinned = await b.evaluate(aboutShown);
        await clickAt(brand.x + 700, brand.y + 300);
        await sleep(400);
        const aboutGone = !await b.evaluate(aboutShown);
        c.check('clicking the brand pins the tooltip about the project; a click outside hides it', aboutPinned && aboutGone, { aboutPinned, aboutGone });
        // Escape lets a pinned tooltip go, also with the pointer still on it (useTip leaves that Escape to usePin)
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brand.x, y: brand.y });
        await b.waitFor(aboutShown, 3000);
        await pressAltP();
        await sleep(200);
        const pinnedOnIt = await b.evaluate(`!!document.querySelector('.rab-n-brand-wrap.pinned')`);
        await press('Escape');
        await sleep(300);
        const escaped = await b.evaluate(`!document.querySelector('.rab-n-brand-wrap.pinned')`) && !await b.evaluate(aboutShown);
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brand.x + 700, y: brand.y + 300 });
        c.check('one Escape lets the pinned tooltip go, with the pointer still on it', pinnedOnIt && escaped, { pinnedOnIt, escaped });

        // the page is the app: no product footer, nothing to scroll
        const page = await b.evaluate(`(() => { const shown = sel => { const e = document.querySelector(sel); return e ? getComputedStyle(e).display : 'absent'; };
            return { header: shown('#header'), footer: shown('#footer'), overflow: document.documentElement.scrollHeight - innerHeight,
                appTop: Math.round(document.querySelector('.rab-n').getBoundingClientRect().top) }; })()`);
        c.check(`the product's header and footer are hidden and the page does not scroll (${page.overflow} px more)`,
            ['none', 'absent'].includes(page.header) && ['none', 'absent'].includes(page.footer) && page.overflow <= 4, page);

        // a module that has not started yet (Confluence starts a module's REST API on the first request to it): a click
        // starts it, then the catalog describes it; skipped where every module has started. First, so that on a cold
        // node the operation the run uses is there
        // clicking a module waiting to start tries to start it on demand (or transitions cleanly to "needs its own login")
        const ws = await b.evaluate(`(async () => { const cat = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/catalog',
            { credentials: 'same-origin' })).json();
            const list = cat.modules.filter(x => x.state === 'failed' && x.reason === 'not-started');
            const pref = list.find(x => ${q(P.title)}.startsWith(x.path.replace(/^\\/+|\\/+$/g, '') + '/'));
            return pref ? [pref, ...list.filter(x => x !== pref)] : list; })()`);
        const startWindow = [-1, -1]; // the failed requests while a module starts
        if (ws.length > 0) {
            await type('[data-testid=search]', '');
            await sleep(400);
            startWindow[0] = b.failedRequests.length;
            let handled = false, lastDiag = null;
            for (const waiting of ws.slice(0, 3)) {
                const sel = `[data-testid=module][data-id=${q('module:' + waiting.id)}]`;
                await b.evaluate(`(document.querySelector('.rab-n-vlist').scrollTop = 0, true)`);
                for (let i = 0; i < 400 && !await b.evaluate(`!!document.querySelector(${q(sel)})`); i++) {
                    await b.evaluate(`(document.querySelector('.rab-n-vlist').scrollTop += 400, true)`);
                    await sleep(40);
                }
                const before = await b.evaluate(`(() => { const r = document.querySelector(${q(sel)}); if (!r) return null; r.scrollIntoView({ block: 'center' });
                    return r.textContent; })()`);
                if (!before) continue;
                await sleep(200);
                const at = await b.evaluate(`(() => { const b = document.querySelector(${q(sel)}).getBoundingClientRect(); return { x: b.left + 80, y: b.top + b.height / 2 }; })()`);
                await clickAt(at.x, at.y);
                const settled = await b.waitFor(`(() => { const r = document.querySelector(${q(sel)}); return !!r && (r.getAttribute('aria-expanded') !== null || /needs its own login/.test(r.textContent || '')); })()`, 45000);
                const started = settled && await b.evaluate(`document.querySelector(${q(sel)})?.getAttribute('aria-expanded') !== null`);
                const after = await text(sel);
                lastDiag = { waiting, before, settled, started, after };
                if (/not started/.test(before) && settled) {
                    handled = true;
                    if (started) break;
                }
            }
            startWindow[1] = b.failedRequests.length;
            c.check(`a module that has not started yet starts or settles as "needs its own login" with a click (${(lastDiag && lastDiag.waiting && lastDiag.waiting.path) || ws[0].path})`,
                handled, lastDiag);
        } else {
            console.log('SKIP no module is waiting to start here that a plain request can start');
        }

        // search: a flat, ranked list
        const searchStart = Date.now();
        await type('[data-testid=search]', P.search);
        // the row as a search result (its words marked): an unfolded module shows the same row before the search applies
        const found = await b.waitFor(`!!document.querySelector('[data-testid=op][data-path=${q(P.title)}] .rab-n-pp-hit')`, 5000);
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
        const cardText = await b.evaluate(`(document.querySelector('[data-testid=row-card]') || {}).textContent || 'no card'`);
        const cardSummary = await b.evaluate(`(document.querySelector('[data-testid=card-summary]') || {}).textContent || ''`);
        c.check('resting on a row opens its card with the app and the access, the path named once', carded
            && cardText.split(P.title).length === 2, cardText);
        if (PRODUCT === 'jira') {
            c.check('the hover card of serverInfo shows its OpenAPI summary', /server/i.test(cardSummary), cardSummary);
        }
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
        if (PRODUCT === 'jira') {
            const opSummary = await text('[data-testid=operation-summary]');
            const opDesc = await text('[data-testid=operation-description]');
            c.check('serverInfo shows its OpenAPI summary and description in the operation view',
                /server/i.test(opSummary) && opDesc.length > 10, { opSummary, opDesc });
        }
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
        const responseTab = name => b.evaluate(`([...document.querySelectorAll('[data-testid=response] [role=tab]')].find(t => t.textContent.startsWith(${q(name)})) || {}).click?.(), true`);
        await responseTab('Response headers');
        const received = await b.waitFor(`document.querySelectorAll('[data-testid=response-headers] .rab-n-header-row').length > 0`, 3000);
        await responseTab('Request headers');
        await b.waitFor(`!!document.querySelector('[data-testid=request-header]')`, 3000);
        const sentHeaders = await b.evaluate(`[...document.querySelectorAll('[data-testid=request-header]')].map(e => e.textContent)`);
        await b.waitFor(`!!document.querySelector('[data-testid=browser-header]')`, 10000);
        const browserHeaders = await b.evaluate(`[...document.querySelectorAll('[data-testid=browser-header]')].map(e => e.textContent)`);
        const cookies = browserHeaders.filter(h => /^cookie:/i.test(h));
        c.check('the response\'s and the request\'s headers have a tab each; the browser\'s headers too, cookie values hidden',
            numbers === 0 && received && sentHeaders.some(h => /^accept:/i.test(h)) && browserHeaders.some(h => /^user-agent:/i.test(h))
            && cookies.every(h => !/=(?!…)[^;\s]{8,}/.test(h)),
            { numbers, received, sentHeaders, browserHeaders: browserHeaders.map(h => h.slice(0, 80)) });
        const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'rab-downloads-'));
        await b.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
        const saved = async (name, ms = 5000) => {
            const file = path.join(downloads, name);
            for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
                if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file, 'utf8');
            }
            return null;
        };
        await click('[data-testid=download]');
        const requestFile = await saved('request-headers.txt');
        await responseTab('Response headers');
        await click('[data-testid=download]');
        const headersFile = await saved('response-headers.txt');
        await responseTab('Pretty');
        await click('[data-testid=download]');
        const bodyFile = await saved('response.json');
        let formatted = false;
        try { formatted = !!bodyFile && /\n  "/.test(bodyFile) && !!JSON.parse(bodyFile); } catch (e) { /* not JSON */ }
        const places = await b.evaluate(`(() => {
            const reqTabs = document.querySelector('.rab-n-request .rab-n-tabbar > .rab-n-tabs');
            const resTabs = document.querySelector('[data-testid=response] .rab-n-tabbar > .rab-n-tabs');
            const cleanTabs = (el) => !!el && el.scrollHeight <= el.clientHeight && getComputedStyle(el).overflowY === 'hidden';
            return {
                download: !!document.querySelector('[data-testid=response] .rab-n-tabbar [data-testid=download]'),
                maximize: !!document.querySelector('[data-testid=response] .rab-n-statusline [data-testid=max-bottom]'),
                noTabScrollbars: cleanTabs(reqTabs) && cleanTabs(resTabs),
            };
        })()`);
        c.check('Download, in the tab bar, saves what the open tab shows: the formatted body, the response\'s or the request\'s headers',
            places.download && places.maximize && places.noTabScrollbars && formatted && /^HTTP \d{3}/.test(headersFile || '') && /^GET \//.test(requestFile || '')
            && /accept: /i.test(requestFile || ''),
            { places, formatted, headers: (headersFile || '').slice(0, 60), request: (requestFile || '').slice(0, 60) });
        fs.rmSync(downloads, { recursive: true, force: true });
        await b.evaluate(`([...document.querySelectorAll('[data-testid=response] [role=tab]')].find(t => /^Pretty/.test(t.textContent)) || {}).click?.(), true`);
        await click('[data-testid=toggle-wrap]');
        const wrappedPretty = await b.waitFor(`!!document.querySelector('[data-testid=pretty-wrapped]')`, 3000);
        await click('[data-testid=toggle-wrap]');
        const unwrappedPretty = await b.waitFor(`!document.querySelector('[data-testid=pretty-wrapped]')`, 3000);
        c.check('Wrap pill toggles wrapped JSON view on and off', wrappedPretty && unwrappedPretty, { wrappedPretty, unwrappedPretty });
        // the find box sits at the right of the response's tab bar, just before Copy and Download, and finds as you type
        const findBox = await b.evaluate(`(() => { const bar = document.querySelector('[data-testid=response] .rab-n-tabbar');
            const input = bar && bar.querySelector('input[type=search]'), copy = bar && bar.querySelector('[data-testid=copy-content]'),
                download = bar && bar.querySelector('[data-testid=download]');
            if (!input || !copy || !download) return null;
            const r = input.closest('.rab-n-find').getBoundingClientRect(), c = copy.getBoundingClientRect(), d = download.getBoundingClientRect(), br = bar.getBoundingClientRect();
            return { sameRow: r.top >= br.top - 1 && r.bottom <= br.bottom + 1, gapToCopy: Math.round(c.left - r.right), copyBeforeDownload: c.right <= d.left + 1,
                right: r.left > br.left + br.width / 2 }; })()`);
        await type('[data-testid=response] .rab-n-tabbar input[type=search]', '":');
        const findCount = await b.waitFor(`/^1 of \\d+/.test((document.querySelector('[data-testid=find-count]') || {}).textContent || '')`, 3000);
        await click('[data-testid=copy-content]');
        const copied = await b.waitFor(`/done|failed/.test(document.querySelector('[data-testid=copy-content]').dataset.state)`, 3000)
            && await b.evaluate(`document.querySelector('[data-testid=copy-content]').dataset.state`);
        c.check('the find box sits at the right, just before Copy and Download, and finds as you type; Copy copies',
            !!findBox && findBox.sameRow && findBox.right && findBox.gapToCopy >= 0 && findBox.gapToCopy < 24 && findBox.copyBeforeDownload
            && findCount && copied === 'done', { findBox, copied, count: await text('[data-testid=find-count]') });
        const tabOrder = await b.evaluate(`[...document.querySelectorAll('.rab-n-request [role=tab]')].map(t => t.textContent.trim())`);
        const javaIdx = tabOrder.indexOf('Java');
        const histIdx = tabOrder.indexOf('History');
        await b.evaluate(`([...document.querySelectorAll('.rab-n-request [role=tab]')].find(t => t.textContent.trim() === 'History') || {}).click?.(), true`);
        const historyHasRow = await b.waitFor(`!!document.querySelector('.rab-n-history-row')`, 5000);
        c.check('the Java tab sits left of History (without a count), and History lists the request',
            javaIdx >= 0 && histIdx === javaIdx + 1 && historyHasRow, { tabOrder, historyHasRow });
        // the Java behind the operation (system administrators): its method and class, the OSGi bundle, the plugin
        await b.evaluate(`([...document.querySelectorAll('.rab-n-request [role=tab]')].find(t => t.textContent.trim() === 'Java') || {}).click?.(), true`);
        await b.waitFor(`!!document.querySelector('[data-testid=java-signature], [data-testid=java-error]')`, 20000);
        const javaText = sel => b.evaluate(`(document.querySelector(${q(sel)}) || {}).textContent || ''`);
        const javaPage = async (page, sel) => { await click(`[data-testid=java-nav-${page}]`); await b.waitFor(`!!document.querySelector(${q(sel)})`, 3000); return javaText(sel); };
        const java = {
            error: await javaText('[data-testid=java-error]'),
            signature: await javaText('[data-testid=java-signature]'),
            colored: await b.evaluate(`!!document.querySelector('[data-testid=java-signature] .rab-n-jc-ann')`),
            pages: await b.evaluate(`[...document.querySelectorAll('.rab-n-java-nav [role=tab]')].map(e => e.textContent)`),
            key: await b.evaluate(`new URLSearchParams(location.search).get('op')`),
        };
        java.cls = await javaPage('class', '[data-testid=java-class]');
        java.bundle = await javaPage('bundle', '[data-testid=java-bundle]');
        java.plugin = await javaPage('plugin', '[data-testid=java-plugin]');
        // the page's tools sit in its heading row, never over the content
        await click('[data-testid=java-nav-method]');
        await b.waitFor(`!!document.querySelector('[data-testid=java-signature]')`, 3000);
        java.tools = await b.evaluate(`(() => { const t = document.querySelector('.rab-n-java-tools'), code = document.querySelector('[data-testid=java-signature]');
            if (!t || !code) return null; return { inHead: !!t.closest('.rab-n-java-head'), clear: t.getBoundingClientRect().bottom <= code.getBoundingClientRect().top + 1,
                floats: getComputedStyle(t).float !== 'none' || getComputedStyle(t).position === 'absolute' }; })()`);
        await click('[data-testid=java-nav-plugin]');
        // the menu fills the tab's height, and a page opens at its top even after another one was scrolled
        java.layout = await b.evaluate(`(() => { const nav = document.querySelector('.rab-n-java-nav').getBoundingClientRect();
            const all = document.querySelector('.rab-n-java').getBoundingClientRect(); return { navFills: Math.abs(nav.height - all.height) <= 1 }; })()`);
        if (await click('[data-testid=java-nav-imports]')) {
            await b.evaluate(`(() => { const p = document.querySelector('.rab-n-java-page'); p.scrollTop = 400; return p.scrollTop; })()`);
            await click('[data-testid=java-nav-plugin]');
            await sleep(100);
            java.layout.pageAtTop = await b.evaluate(`document.querySelector('.rab-n-java-page').scrollTop === 0`);
        }
        const unknown = await b.evaluate(`fetch(${q(CONTEXT)} + '/rest/restbrowser/1/catalog/details?op=' + encodeURIComponent('no.such:module:GET:x'),
            { credentials: 'same-origin' }).then(r => r.status)`);
        c.check('the Java tab: a menu of pages (method, class, bundle, plugin, …), the method with coloured annotations',
            !java.error && java.signature.includes('(') && java.colored && java.pages.length >= 6
            && java.layout.navFills && java.layout.pageAtTop !== false
            && !!java.tools && java.tools.inHead && java.tools.clear && !java.tools.floats
            && /Name/.test(java.cls) && /Symbolic name|Not in an OSGi bundle/.test(java.bundle)
            && java.plugin.includes(java.key.split(':')[0]) && unknown === 404,
            { ...java, signature: java.signature.slice(0, 200), bundle: java.bundle.slice(0, 120), plugin: java.plugin.slice(0, 120), unknown });
        await click('[data-testid=java-nav-method]');
        await b.waitFor(`!!document.querySelector('[data-testid=load-source]')`, 3000);
        const decompileBtnPos = await b.evaluate(`(() => {
            const btn = document.querySelector('[data-testid=load-class-source]');
            const sig = document.querySelector('[data-testid=java-signature]');
            return btn && sig ? { aboveSignature: btn.getBoundingClientRect().bottom <= sig.getBoundingClientRect().top + 1 } : null;
        })()`);
        await click('[data-testid=load-source]');
        const decompiled = await b.waitFor(`!!document.querySelector('[data-testid=java-source-code]')`, 15000);
        const srcText = await javaText('[data-testid=java-source-code]');
        const methodName = (await javaText('[data-testid=java-signature] .rab-n-jc-method')).trim();
        c.check(`decompiling ${P.title} in the Java tab shows the method's source (${methodName}) with decompile buttons at top`,
            decompiled && !!decompileBtnPos && decompileBtnPos.aboveSignature && !!methodName && srcText.includes(methodName) && srcText.includes('{'),
            { methodName, decompileBtnPos, src: srcText.slice(0, 200) });
        // Vineflower is the default decompiler; hover a Java type for the rich class/OSGi tooltip,
        // then click "Decompile class" which always opens the full class in the tabbed dialog focused on the method header
        const vfLoaded = await b.waitFor(`/Vineflower/.test((document.querySelector('[data-testid=java-source-engine]') || {}).textContent || '')`, 15000);

        // hover a Java type in the operation header (Returns) or source to verify the rich class hover card
        const tipAnchor = await b.evaluate(`(() => {
            const el = document.querySelector('[data-testid=operation-output-type] [data-class-ref], [data-testid=java-source-code] [data-class-ref]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, ref: el.dataset.classRef };
        })()`);
        let richTipOk = false;
        if (tipAnchor) {
            await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tipAnchor.x, y: tipAnchor.y });
            richTipOk = await b.waitFor(`(() => {
                const card = document.querySelector('[data-testid=class-hover-card]');
                const competing = document.querySelector('[data-testid=ui-tip]');
                return !!card && !competing && /Bytecode|ClassLoader|OSGi bundle|Origin/.test(card.textContent);
            })()`, 8000);
            await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
            await sleep(200);
        }
        c.check(`hovering a Java type shows the rich class/OSGi tooltip (${tipAnchor && tipAnchor.ref})`, richTipOk, tipAnchor);

        // OpenAPI export button in OperationHeader downloads the module spec
        await click('[data-testid=export-module-openapi]');
        const openApiExported = await b.waitFor(`document.querySelector('[data-testid=export-module-openapi]')?.dataset.state === 'done'`, 10000);
        c.check('OpenAPI button in operation header exports the module OpenAPI 3.1 document', openApiExported);

        await click('[data-testid=load-class-source]');
        const dlgOpen = await b.waitFor(`(() => {
            const box = document.querySelector('[data-testid=source-dialog] [data-testid=dialog-source-code]');
            const fl = box && box.querySelector('[data-focus-line=true]');
            return !!box && Number(box.dataset.lineCount) > 5 && !!fl && fl.textContent.includes(${q(methodName)});
        })()`, 15000);
        const dlgClass1 = await javaText('[data-testid=dialog-class-name]');
        const declAndRest = await b.evaluate(`(() => {
            const dlg = document.querySelector('[data-testid=source-dialog]');
            const boldMethod = dlg && dlg.querySelector('.rab-n-jc-decl-method');
            const restBadge = dlg && dlg.querySelector('[data-testid=outline-rest-badge]');
            const epLink = dlg && dlg.querySelector('[data-testid=source-endpoint-link]');
            const outlineEl = dlg && dlg.querySelector('[data-testid=source-dialog-outline]');
            return {
                boldMethod: boldMethod ? { text: boldMethod.textContent, weight: getComputedStyle(boldMethod).fontWeight } : null,
                restBadge: restBadge ? { text: restBadge.textContent, http: restBadge.dataset.httpMethod } : null,
                epLink: epLink ? { href: epLink.getAttribute('href'), target: epLink.target, text: epLink.textContent.trim() } : null,
                outlineWidthBefore: outlineEl ? Math.round(outlineEl.getBoundingClientRect().width) : 0,
            };
        })()`);
        // resize outline panel with keyboard and verify width changes and persists after minimize/reopen
        await b.evaluate(`document.querySelector('[data-testid=source-dialog-outline-resize]')?.focus(), true`);
        for (let i = 0; i < 4; i++) await press('ArrowRight');
        await sleep(100);
        const outlineWidthAfter = await b.evaluate(`Math.round(document.querySelector('[data-testid=source-dialog-outline]').getBoundingClientRect().width)`);
        c.check('Decompile class opens in dialog focused on method header, bolds declarations, marks REST endpoints with open-in-tab links, and resizes outline',
            vfLoaded && dlgOpen && !!declAndRest.boldMethod && Number(declAndRest.boldMethod.weight) >= 700
            && !!declAndRest.restBadge && declAndRest.restBadge.text.length === 1
            && !!declAndRest.epLink && declAndRest.epLink.target === '_blank' && /\?op=/.test(declAndRest.epLink.href)
            && outlineWidthAfter > declAndRest.outlineWidthBefore,
            { vfLoaded, dlgOpen, dlgClass1, declAndRest, outlineWidthAfter });

        // switch decompiler in place inside the dialog and verify decompiler version link sits directly left of the toggle, plus Pretty toggle and CFR outline work
        await click('[data-testid=source-dialog] [data-testid=decompiler-cfr]');
        const dlgCfr = await b.waitFor(`/CFR/.test((document.querySelector('[data-testid=dialog-decompiler]') || {}).textContent || '')`, 15000);
        const cfrOutlineOrig = await b.evaluate(`document.querySelectorAll('[data-testid=outline-item]').length`);
        await click('[data-testid=source-dialog] [data-testid=toggle-pretty-source]');
        const prettyOn = await b.waitFor(`document.querySelector('[data-testid=source-dialog] [data-testid=toggle-pretty-source]')?.getAttribute('aria-pressed') === 'true'`, 2000);
        const cfrOutlinePretty = await b.evaluate(`document.querySelectorAll('[data-testid=outline-item]').length`);
        await click('[data-testid=source-dialog] [data-testid=toggle-pretty-source]');
        const prettyOff = await b.waitFor(`document.querySelector('[data-testid=source-dialog] [data-testid=toggle-pretty-source]')?.getAttribute('aria-pressed') === 'false'`, 2000);
        const decompilerLink = await b.evaluate(`(() => {
            const link = document.querySelector('[data-testid=dialog-decompiler]');
            const toggle = document.querySelector('[data-testid=source-dialog] [data-testid=decompiler-toggle]');
            if (!link || !toggle) return null;
            const lr = link.getBoundingClientRect(), tr = toggle.getBoundingClientRect();
            return { href: link.getAttribute('href'), target: link.target, leftOfToggle: lr.right <= tr.left + 1 && tr.left - lr.right < 24 };
        })()`);
        // click another class reference inside the dialog to open a second tab
        const ref1 = dlgClass1;
        const ref2 = await b.evaluate(`(() => {
            const cur = (document.querySelector('[data-testid=dialog-class-name]') || {}).textContent || '';
            const links = [...document.querySelectorAll('[data-testid=dialog-source-code] [data-class-ref]')];
            const pick = links.find(e => e.dataset.classRef && e.dataset.classRef !== cur) || null;
            if (!pick) return null;
            pick.click();
            return pick.dataset.classRef;
        })()`);
        const twoTabs = !!ref2 && await b.waitFor(`document.querySelectorAll('[data-testid=source-dialog-tab]').length >= 2 && !!document.querySelector('[data-testid=dialog-source-code]')`, 15000);
        // maximize & restore dialog, check outline navigation, status bar, and ZIP button
        const outlineAndStatus = await b.evaluate(`(() => {
            const items = document.querySelectorAll('[data-testid=outline-item]');
            const status = (document.querySelector('[data-testid=source-dialog-status]') || {}).textContent || '';
            const zipBtn = document.querySelector('[data-testid=source-dialog-download-zip]');
            const hdr = document.querySelector('[data-testid=source-dialog-header]');
            const strip = hdr && hdr.querySelector('.rab-n-modal-tabstrip');
            const hdrBg = hdr && (getComputedStyle(hdr).backgroundImage || getComputedStyle(hdr).backgroundColor);
            const stripSt = strip && getComputedStyle(strip);
            const noTitleScrollbars = !!hdr && !!strip
                && hdr.scrollHeight <= hdr.clientHeight
                && hdr.scrollWidth <= hdr.clientWidth
                && strip.scrollHeight <= strip.clientHeight
                && stripSt.overflowY === 'hidden'
                && stripSt.scrollbarWidth === 'none';
            if (items.length > 0) items[0].click();
            return { outlineCount: items.length, status, hasZip: !!zipBtn && !zipBtn.disabled, hdrBg, noTitleScrollbars };
        })()`);
        // check Impls / Callers / Grep / Files intelligence panels & bundle resource preview inside SourceDialog
        await click('[data-testid=source-panel-implementations]');
        const implPanelOk = await b.waitFor(`!!document.querySelector('[data-testid=implementations-panel]') && !/Scanning/.test((document.querySelector('[data-testid=implementations-panel]') || {}).textContent || '')`, 15000);
        await click('[data-testid=source-panel-callers]');
        const callersPanelOk = await b.waitFor(`!!document.querySelector('[data-testid=callers-panel]') && !/Searching callers/.test((document.querySelector('[data-testid=callers-panel]') || {}).textContent || '')`, 15000);
        await click('[data-testid=source-panel-grep]');
        await type('[data-testid=grep-query-input]', 'rest');
        await click('[data-testid=grep-submit]');
        const grepPanelOk = await b.waitFor(`!!document.querySelector('[data-testid=grep-panel] .rab-n-java-nav-count')`, 15000);
        await click('[data-testid=source-panel-resources]');
        const resListed = await b.waitFor(`!!document.querySelector('[data-testid=bundle-resource-item]')`, 15000);
        let resPreviewOk = false, resEscapedOk = false;
        if (resListed) {
            await click('[data-testid=bundle-resource-item]');
            resPreviewOk = await b.waitFor(`!!document.querySelector('[data-testid=bundle-resource-preview]') && !/Loading /.test((document.querySelector('[data-testid=bundle-resource-preview]') || {}).textContent || '')`, 10000);
            await press('Escape');
            resEscapedOk = await b.waitFor(`!document.querySelector('[data-testid=bundle-resource-preview]') && !!document.querySelector('[data-testid=dialog-source-code]')`, 3000);
        }
        await click('[data-testid=source-panel-outline]');
        c.check('SourceDialog code-intel panels (Impls, Callers, Grep, Files) and bundle resource preview work cleanly',
            implPanelOk && callersPanelOk && grepPanelOk && resListed && resPreviewOk && resEscapedOk,
            { implPanelOk, callersPanelOk, grepPanelOk, resListed, resPreviewOk, resEscapedOk });

        await click('[data-testid=source-dialog-outline-toggle]');
        const outlineCollapsed = await b.waitFor(`!document.querySelector('[data-testid=source-dialog-outline]')`, 2000);
        await click('[data-testid=source-dialog-outline-toggle]');
        const outlineReopened = await b.waitFor(`!!document.querySelector('[data-testid=source-dialog-outline]')`, 2000);
        await click('[data-testid=source-dialog-maximize]');
        const dlgMax = await b.waitFor(`(() => {
            const el = document.querySelector('[data-testid=source-dialog] [role=dialog]');
            if (!el || el.dataset.state !== 'max') return false;
            const r = el.getBoundingClientRect();
            return r.left >= 8 && r.right <= document.documentElement.clientWidth - 8;
        })()`, 2000);
        await click('[data-testid=source-dialog-maximize]');
        const dlgRestored = await b.waitFor(`document.querySelector('[data-testid=source-dialog] [role=dialog]')?.dataset.state === 'normal'`, 2000);
        // Escape minimizes dialog while preserving tabs, and top-panel Classes button brings it back (keeping no border/color change and remembered outline width)
        await press('Escape');
        const dlgMinimized = await b.waitFor(`!document.querySelector('[data-testid=source-dialog]') && (document.querySelector('[data-testid=classes-tab-count]') || {}).textContent === '2'`, 3000);
        const classesBtnStyle = await b.evaluate(`(() => {
            const btn = document.querySelector('[data-testid=open-classes-dialog]');
            const st = btn && getComputedStyle(btn);
            return st && { border: st.borderTopWidth, bg: st.backgroundColor };
        })()`);
        await click('[data-testid=open-classes-dialog]');
        const dlgReopened = await b.waitFor(`document.querySelectorAll('[data-testid=source-dialog-tab]').length === 2`, 3000);
        const outlineWidthRemembered = await b.evaluate(`Math.round(document.querySelector('[data-testid=source-dialog-outline]').getBoundingClientRect().width)`);
        // close individual tab + undo, close all + undo
        await click('[data-testid=source-dialog-tab-close]');
        const oneLeft = await b.waitFor(`document.querySelectorAll('[data-testid=source-dialog-tab]').length === 1`, 2000);
        await click('[data-testid=source-dialog-undo]');
        const backToTwo = await b.waitFor(`document.querySelectorAll('[data-testid=source-dialog-tab]').length === 2`, 2000);
        await click('[data-testid=source-dialog-close-all]');
        const zeroLeft = await b.waitFor(`document.querySelectorAll('[data-testid=source-dialog-tab]').length === 0`, 2000);
        await click('[data-testid=source-dialog-undo]');
        const restoredAll = await b.waitFor(`document.querySelectorAll('[data-testid=source-dialog-tab]').length === 2`, 2000);
        await press('Escape');
        const dlgClosed = await b.waitFor(`!document.querySelector('[data-testid=source-dialog]')`, 3000);
        c.check(`tabbed decompiler dialog drills (${ref1} -> ${ref2}), remembers outline width, has clean title bar and themed header/outline/status/ZIP/Pretty, maximizes, minimizes keeping tabs, reopens from top panel, and supports close/close-all/undo`,
            dlgOpen && !!dlgClass1 && dlgCfr && cfrOutlineOrig > 0 && cfrOutlinePretty > 0 && prettyOn && prettyOff && !!decompilerLink && /^https:\/\/github\.com\/leibnitz27\/cfr$/.test(decompilerLink.href) && decompilerLink.target === '_blank' && decompilerLink.leftOfToggle
            && twoTabs && outlineAndStatus.outlineCount > 0 && !!outlineAndStatus.hdrBg && outlineAndStatus.hdrBg !== 'none' && outlineAndStatus.noTitleScrollbars && outlineCollapsed && outlineReopened && outlineAndStatus.hasZip
            && outlineWidthRemembered === outlineWidthAfter
            && /Line \d+ \/ \d+/.test(outlineAndStatus.status) && classesBtnStyle && classesBtnStyle.border === '0px'
            && dlgMax && dlgRestored && dlgMinimized && dlgReopened
            && oneLeft && backToTwo && zeroLeft && restoredAll && dlgClosed,
            { ref1, dlgClass1, dlgCfr, cfrOutlineOrig, cfrOutlinePretty, prettyOn, prettyOff, decompilerLink, twoTabs, outlineAndStatus, outlineCollapsed, outlineReopened, outlineWidthRemembered, classesBtnStyle, dlgMax, dlgRestored, dlgMinimized, dlgReopened, oneLeft, backToTwo, zeroLeft, restoredAll, dlgClosed });

        // agent REST API & llms.txt live check
        const agentApi = await b.evaluate(`(async () => {
            const llms = await fetch(${q(CONTEXT)} + '/plugins/servlet/rest-api-browser/llms.txt', { credentials: 'same-origin' });
            const llmsText = await llms.text();
            const llmsFull = await fetch(${q(CONTEXT)} + '/plugins/servlet/rest-api-browser/llms-full.txt', { credentials: 'same-origin' });
            const llmsFullText = await llmsFull.text();
            const selfOpenApi = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/openapi', { credentials: 'same-origin' })).json();
            const selfOpenApiJson = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/openapi.json', { credentials: 'same-origin' })).json();
            const opsSearch = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/catalog/operations?limit=5', { credentials: 'same-origin' })).json();
            const firstOp = (opsSearch.operations && opsSearch.operations[0]) || {};
            const modOpenApi = firstOp.module
                ? await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/catalog/openapi?module=' + encodeURIComponent(firstOp.module) + '&includeSchemas=false', { credentials: 'same-origin' })).json()
                : {};
            const curIdx = await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/catalog/index/current', { credentials: 'same-origin' });
            const cls = encodeURIComponent(${q(dlgClass1)});
            const metaResp = await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/code/class?class=' + cls + '&view=compact&outline=true', { credentials: 'same-origin' });
            const metaEtag = metaResp.headers.get('ETag');
            const meta304 = metaEtag
                ? await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/code/class?class=' + cls + '&view=compact&outline=true', { credentials: 'same-origin', headers: { 'If-None-Match': metaEtag } })
                : { status: 0 };
            const meta = await metaResp.json();
            const schema = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/code/schema?class=' + cls, { credentials: 'same-origin' })).json();
            const graph = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/code/graph?class=' + cls + '&preset=domain&depth=1&maxNodes=10', { credentials: 'same-origin' })).json();
            const grep = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/code/grep?q=restbrowser&limit=5', { credentials: 'same-origin' })).json();
            const resList = meta.bundleId >= 0
                ? await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/code/resource?bundleId=' + meta.bundleId + '&limit=5', { credentials: 'same-origin' })).json()
                : { entries: [] };
            const ctx = firstOp.key
                ? await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/code/context', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
                    body: JSON.stringify({ op: firstOp.key, maxLines: 40, includeImplementations: false }),
                })).json()
                : {};
            const mcpHeaders = { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' };
            const mcpInit = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/mcp', {
                method: 'POST', credentials: 'same-origin', headers: mcpHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
            })).json();
            const mcpList = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/mcp', {
                method: 'POST', credentials: 'same-origin', headers: mcpHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
            })).json();
            const mcpCall = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/mcp', {
                method: 'POST', credentials: 'same-origin', headers: mcpHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_operations', arguments: { limit: 2 } } }),
            })).json();
            const mcpResList = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/mcp', {
                method: 'POST', credentials: 'same-origin', headers: mcpHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list' }),
            })).json();
            const mcpResRead = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/mcp', {
                method: 'POST', credentials: 'same-origin', headers: mcpHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'rab://llms.txt' } }),
            })).json();
            const mcpPromptsList = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/mcp', {
                method: 'POST', credentials: 'same-origin', headers: mcpHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'prompts/list' }),
            })).json();
            const mcpPromptGet = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/mcp', {
                method: 'POST', credentials: 'same-origin', headers: mcpHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'prompts/get', params: { name: 'debug-stuck-endpoint', arguments: { target: '/rest/test' } } }),
            })).json();
            const plain = await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/code/source?class=' + cls + '&startLine=1&maxLines=10&format=text', { credentials: 'same-origin' });
            const plainText = await plain.text();
            const md = await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/code/source?class=' + cls + '&startLine=1&maxLines=5&lineNumbers=true&format=markdown', { credentials: 'same-origin' });
            const mdText = await md.text();
            return {
                llmsOk: llms.status === 200 && llmsText.startsWith('# REST API Browser') && llmsText.includes('/catalog/operations') && llmsText.includes('/code/context') && llmsText.includes('/mcp'),
                llmsFullOk: llmsFull.status === 200 && llmsFullText.includes('Full Agent Reference') && llmsFullText.includes('mcpServers'),
                openApiOk: selfOpenApi.openapi === '3.1.0' && !!selfOpenApi.paths && selfOpenApiJson.openapi === '3.1.0' && !!selfOpenApiJson.paths && modOpenApi.openapi === '3.1.0',
                opsOk: Array.isArray(opsSearch.operations) && opsSearch.operations.length > 0,
                curIdxOk: curIdx.status === 200 && Boolean(curIdx.headers.get('X-Catalog-Hash')),
                metaOk: meta.name === ${q(dlgClass1)} && meta.bytecodeBytes > 0 && Array.isArray(meta.fields) && Array.isArray(meta.outline) && meta.refs === undefined && meta304.status === 304,
                schemaOk: schema.schema && schema.schema.$schema && schema.schema.$schema.includes('2020-12'),
                graphOk: graph.root === ${q(dlgClass1)} && Array.isArray(graph.nodes) && graph.nodes.length >= 1,
                grepOk: Array.isArray(grep.results) && grep.scannedClasses >= 0,
                resourceOk: Array.isArray(resList.entries),
                contextOk: ctx.key === firstOp.key && !!ctx.details && !!ctx.source,
                mcpOk: mcpInit.result && mcpInit.result.protocolVersion === '2025-03-26'
                    && mcpInit.result.capabilities && !!mcpInit.result.capabilities.resources && !!mcpInit.result.capabilities.prompts
                    && mcpList.result && Array.isArray(mcpList.result.tools) && mcpList.result.tools.length >= 10
                    && mcpCall.result && mcpCall.result.isError === false
                    && mcpResList.result && Array.isArray(mcpResList.result.resources) && mcpResList.result.resources.length >= 4
                    && mcpResRead.result && Array.isArray(mcpResRead.result.contents) && mcpResRead.result.contents.length === 1
                    && mcpPromptsList.result && Array.isArray(mcpPromptsList.result.prompts) && mcpPromptsList.result.prompts.length >= 3
                    && mcpPromptGet.result && Array.isArray(mcpPromptGet.result.messages) && /\/rest\/test/.test(JSON.stringify(mcpPromptGet.result.messages)),
                plainOk: plain.status === 200 && plainText.length > 10,
                mdOk: md.status === 200 && (md.headers.get('content-type') || '').includes('text/markdown') && mdText.includes('1 |'),
            };
        })()`);
        c.check('agent-friendly REST, OpenAPI 3.1, MCP, and llms.txt/llms-full.txt endpoints respond cleanly',
            agentApi.llmsOk && agentApi.llmsFullOk && agentApi.openApiOk && agentApi.opsOk && agentApi.curIdxOk
            && agentApi.metaOk && agentApi.schemaOk && agentApi.graphOk && agentApi.grepOk && agentApi.resourceOk
            && agentApi.contextOk && agentApi.mcpOk && agentApi.plainOk && agentApi.mdOk,
            agentApi);
        await b.shot(path.join(SHOTS, `${PRODUCT}-next-7-java.png`));

        // the request and the response each take the whole screen with their button, and give it back
        const box = sel => b.evaluate(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const r = e.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), shown: getComputedStyle(e).display !== 'none' }; })()`);
        const screen = await b.evaluate(`({ w: innerWidth, h: innerHeight })`);
        const whole = r => !!r && r.shown && r.top <= 1 && Math.abs(r.w - screen.w) <= 20 && Math.abs(r.h - screen.h) <= 2;
        const inert = () => b.evaluate(`({ topbar: document.querySelector('.rab-n-topbar').inert, side: document.querySelector('.rab-n-side').inert })`);
        await click('[data-testid=max-top]');
        await sleep(150);
        const top = { operation: await box('[data-testid=operation]'), response: await box('[data-testid=response]'), inert: await inert() };
        await press('Escape');
        await sleep(150);
        const topBack = await box('[data-testid=operation]');
        const inertBack = await inert();
        c.check('what a box on the whole screen covers (the header, the list) is inert until it gives the screen back',
            top.inert.topbar && top.inert.side && !inertBack.topbar && !inertBack.side, { during: top.inert, after: inertBack });
        await click('[data-testid=max-bottom]');
        await sleep(150);
        const bottom = { response: await box('[data-testid=response]'), head: await box('.rab-n-op-head') };
        await click('[data-testid=max-bottom]');
        await sleep(150);
        const bottomBack = await box('.rab-n-op-head');
        c.check('the request and the response each take the whole screen and give it back (button, Escape)',
            whole(top.operation) && !top.response.shown && !whole(topBack) && whole(bottom.response) && !bottom.head.shown && bottomBack.shown,
            { screen, top, topBack, bottom, bottomBack });

        // a path parameter's value is URL-encoded; the request is a GET of something that cannot exist
        let templatedKey = null;
        if (await openOp(P.templated.split('/').slice(-2).join(' ').replace(/[{}]/g, ''), P.templated)) {
            templatedKey = await b.evaluate(`new URLSearchParams(location.search).get('op')`);
            const stickyJava = await b.evaluate(`((document.querySelector('.rab-n-request [role=tab][aria-selected=true]') || {}).textContent || '').trim() === 'Java'`);
            c.check('switching operations keeps the active request tab sticky (Java stays selected)', stickyJava);
            await b.evaluate(`([...document.querySelectorAll('.rab-n-request [role=tab]')].find(t => /^Params\\b/.test(t.textContent.trim())) || {}).click?.(), true`);
            await b.waitFor(`!!document.querySelector('input[name=' + ${q(q(P.param))} + ']')`, 5000);
            const mark = () => b.evaluate(`(() => { const i = document.querySelector('input[name=${P.param}]');
                const m = i && i.parentElement.querySelector('[data-testid=check]'); return m ? m.dataset.state : 'none'; })()`);
            const colorOf = sel => b.evaluate(`(() => { const e = document.querySelector(${q(sel)}); return e ? getComputedStyle(e).color : null; })()`);
            const templateColor = await colorOf('[data-testid=live-url] .rab-n-pp-param');
            const empty = { mark: await mark(), tab: await b.evaluate(`!!document.querySelector('[data-testid=params-warn]')`),
                send: await b.evaluate(`document.querySelector('[data-testid=send]').disabled`),
                curl: await b.evaluate(`document.querySelector('[data-testid=copy-curl]').disabled`) };
            c.check('Copy curl is disabled like Send while a required value is missing', empty.send && empty.curl, empty);
            await b.shot(path.join(SHOTS, `${PRODUCT}-next-5-form.png`));
            const paramLayout = await b.evaluate(`(() => {
                const pane = document.querySelector('#rab-n-request-pane');
                const names = [...document.querySelectorAll('[data-testid=params] .rab-n-param-name')].map(el => {
                    const r = el.getBoundingClientRect();
                    return { text: el.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
                });
                return {
                    overflowX: pane ? pane.scrollWidth - pane.clientWidth : 999,
                    names,
                    bad: names.filter(n => n.text.length >= 4 && (n.w < 40 || (n.text.length <= 22 && n.h > 42))),
                };
            })()`);
            c.check('parameter labels stay horizontal without letter-by-letter wrapping or horizontal overflow',
                paramLayout.names.length > 0 && paramLayout.bad.length === 0 && paramLayout.overflowX <= 1, paramLayout);
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
                // the status code's rich tooltip: after a rest of the pointer, what the code means (outside the status
                // line's live region); Escape hides it
                const chip = await b.evaluate(`(() => { const el = document.querySelector('[data-testid=response-status]');
                    if (!el) return null; const r = el.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
                if (chip) {
                    // from elsewhere, so the pointer enters it (that also brings back a tooltip hidden with Escape before)
                    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
                    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: chip.x, y: chip.y });
                    await b.waitFor(`getComputedStyle(document.querySelector('[data-testid=status-tip]')).visibility === 'visible'`, 3000);
                    const tipOf = () => b.evaluate(`(() => { const t = document.querySelector('[data-testid=status-tip]');
                        return t ? { shown: getComputedStyle(t).visibility === 'visible', live: !!t.closest('[role=status], [aria-live]'),
                            wrap: t.parentElement.className, text: t.textContent.slice(0, 120) } : null; })()`);
                    const tip = await tipOf();
                    await press('Escape');
                    await sleep(200);
                    const tipAfter = await tipOf();
                    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
                    const code = (await text('[data-testid=response-status]')).trim().split(' ')[0];
                    c.check('the status code has a rich tooltip that explains it, outside the live region, and Escape hides it',
                        !!tip && tip.shown && !tip.live && tip.text.startsWith(code) && tip.text.length > code.length + 20 && !tipAfter.shown,
                        { tip, tipAfter });
                    // clicking a non-link rich tooltip target pins it; clicking elsewhere unpins it
                    await clickAt(chip.x, chip.y);
                    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
                    await sleep(200);
                    const tipClickPinned = await tipOf();
                    await clickAt(5, 5);
                    await sleep(200);
                    const tipClickUnpinned = await tipOf();
                    c.check('clicking a non-link rich tooltip target pins it, and clicking elsewhere unpins it',
                        !!tipClickPinned && tipClickPinned.shown && /pinned/.test(tipClickPinned.wrap)
                        && !!tipClickUnpinned && !tipClickUnpinned.shown,
                        { tipClickPinned, tipClickUnpinned });
                } else {
                    c.check('the status code badge is rendered for rich tooltip checks', false);
                }
            }
            // delegated rich tooltips on buttons/links (e.g. Send button)
            const sendBtn = await b.evaluate(`(() => { const e = document.querySelector('[data-testid=send]');
                if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
            if (sendBtn) {
                await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sendBtn.x, y: sendBtn.y });
                const uiTipShown = await b.waitFor(`!!document.querySelector('[data-testid=ui-tip]')`, 2500);
                const uiTipText = uiTipShown ? (await text('[data-testid=ui-tip]')).trim() : '';
                await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
                const uiTipGone = await b.waitFor(`!document.querySelector('[data-testid=ui-tip]')`, 1500);
                c.check('buttons and links show rich explanatory tooltips on hover and dismiss when leaving',
                    uiTipShown && uiTipText.length > 20 && uiTipGone, { uiTipShown, uiTipText, uiTipGone });
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
            // the colour tones of a row: its ticks, and a module header's icon (none for an internal module)
            const tones = row => [...row.querySelectorAll('.rab-n-tick, .rab-n-module-icon')]
                .map(t => ([...t.classList].find(c => c.startsWith('rab-n-tone-')) || '').slice(11)).filter(Boolean).join(' ');
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
        // unfolding scrolls the list to the selected operation; the headers are at its top
        await b.evaluate(`(document.querySelector('.rab-n-vlist').scrollTop = 0, true)`);
        await b.waitFor(`!!document.querySelector('[data-testid=module]') && !!document.querySelector('[data-testid=op]')`, 3000);
        const groups = await b.evaluate(`(() => { try { const m = document.querySelector('[data-testid=module][aria-expanded]');
            if (!m) return { error: 'no foldable module row' };
            const st = getComputedStyle(m), chevron = m.querySelector('.rab-n-chevron svg'), icon = m.querySelector('.rab-n-module-icon svg');
            return { fill: st.backgroundImage !== 'none' ? st.backgroundImage.slice(0, 60) : st.backgroundColor, chevron: !!chevron,
                turned: chevron ? getComputedStyle(chevron).transform : null, expanded: m.getAttribute('aria-expanded'), icon: !!icon }; }
            catch (e) { return { error: String(e) }; } })()`);
        c.check('the module headers are tree nodes: a chevron that turns when open, a kind icon, no fill', !!groups && !groups.error
            && groups.chevron && groups.icon && /^rgba\(0, 0, 0, 0\)$/.test(groups.fill)
            && (groups.expanded === 'true') === (groups.turned !== 'none'), groups);

        // the wheel scrolls the list to its end, and that end is inside the window (not under a banner added later)
        const lb = await b.evaluate(`(() => { const l = document.querySelector('.rab-n-vlist'); l.scrollTop = 0; const r = l.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 300) }; })()`);
        for (let i = 0; i < 80; i++) {
            await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: lb.x, y: lb.y, deltaX: 0, deltaY: 3000 });
            await sleep(30);
        }
        await sleep(500);
        const end = await b.evaluate(`(() => { const l = document.querySelector('.rab-n-vlist'), r = l.getBoundingClientRect();
            return { top: Math.round(l.scrollTop), max: l.scrollHeight - l.clientHeight, bottom: Math.round(r.bottom), viewport: document.documentElement.clientHeight }; })()`);
        c.check('the wheel scrolls the list to its end, and the end is inside the window', end.top >= end.max - 1 && end.bottom <= end.viewport, end);
        // again after a real click on a module header (it folds and unfolds, and its row keeps the focus): the focused
        // row is kept rendered as the list scrolls away from it, and must not pull the list back
        await b.evaluate(`(document.querySelector('.rab-n-vlist').scrollTop = 0, true)`);
        await sleep(300);
        const mr = await b.evaluate(`(() => { const m = document.querySelector('[data-testid=module][aria-expanded]'); if (!m) return null;
            const r = m.getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height / 2 }; })()`);
        if (mr) {
            for (let n = 0; n < 2; n++) {
                await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mr.x, y: mr.y });
                await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mr.x, y: mr.y, button: 'left', clickCount: 1 });
                await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mr.x, y: mr.y, button: 'left', clickCount: 1 });
                await sleep(400);
            }
            await b.evaluate(`(() => { const l = document.querySelector('.rab-n-vlist'); window.__back = 0; let last = l.scrollTop;
                l.addEventListener('scroll', () => { if (l.scrollTop < last - 30) window.__back++; last = l.scrollTop; }); })()`);
            for (let i = 0; i < 80; i++) {
                await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: lb.x, y: lb.y, deltaX: 0, deltaY: 400 });
                await sleep(40);
            }
            await sleep(500);
            const after = await b.evaluate(`(() => { const l = document.querySelector('.rab-n-vlist');
                return { top: Math.round(l.scrollTop), max: l.scrollHeight - l.clientHeight, snapBacks: window.__back,
                    focused: (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.id) || null }; })()`);
            c.check('after a click on a module header the wheel still scrolls down, never pulled back to the focused row',
                after.snapBacks === 0 && after.top > 2000, after);
        }
        await b.evaluate(`(document.querySelector('.rab-n-vlist').scrollTop = 0, true)`);

        // a click holds a row's card back only while the pointer stays on it: out of the list and back, the card comes
        await sleep(300);
        const hr = await b.evaluate(`(() => { const m = document.querySelector('[data-testid=module][aria-expanded]'); if (!m) return null;
            const r = m.getBoundingClientRect(), side = document.querySelector('.rab-n-sidebar').getBoundingClientRect();
            return { x: r.left + 60, y: r.top + r.height / 2, out: side.right + 300 }; })()`);
        if (hr) {
            for (let n = 0; n < 2; n++) { // folds and unfolds it: as it was
                await clickAt(hr.x, hr.y);
                await sleep(300);
            }
            await sleep(600);
            const heldBack = !await b.evaluate(`!!document.querySelector('[data-testid=row-card]')`);
            await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hr.out, y: hr.y });
            await sleep(200);
            await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hr.x, y: hr.y });
            const cardBack = await b.waitFor(`!!document.querySelector('[data-testid=row-card]')`, 3000);
            await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hr.out, y: hr.y });
            c.check('a clicked row shows no card until the pointer leaves the list; back on the row, its card comes',
                heldBack && cardBack, { heldBack, cardBack });
        }

        // skins: Balanced by default; each one from the menu changes the header; the choice is kept (checked after the reload below)
        const skinOf = () => b.evaluate(`(() => { const r = document.querySelector('.rab-n'); const t = getComputedStyle(document.querySelector('.rab-n-topbar'));
            const band = document.querySelector('.rab-n-statusline'), pane = document.querySelector('.rab-n-tabpane, .rab-n-request');
            return { skin: r.dataset.skin, image: t.backgroundImage.slice(0, 60), color: t.backgroundColor,
                band: band && getComputedStyle(band).backgroundColor, pane: pane && getComputedStyle(pane.closest('.rab-n-main') || pane).backgroundColor }; })()`);
        const menuOpen = () => b.evaluate(`!!document.querySelector('[data-testid=menu]')`);
        const pickSkin = async id => {
            if (!await menuOpen()) await click('[data-testid=menu-button]');
            await b.waitFor(`!!document.querySelector('[data-testid=skin-${id}]')`, 3000);
            await click(`[data-testid=skin-${id}]`); await sleep(200); return skinOf();
        };
        const skins = { balanced: await skinOf() };
        for (const id of ['vivid', 'navy']) skins[id] = await pickSkin(id);
        c.check('choosing a skin leaves the menu open, like the colour modes', await menuOpen());
        c.check('the menu switches the skin: Balanced by default, Vivid, Calm (a navy header)',
            skins.balanced.skin === 'balanced' && /gradient/.test(skins.balanced.image) && skins.vivid.skin === 'vivid'
            && /gradient/.test(skins.vivid.image) && skins.vivid.image !== skins.balanced.image
            && skins.navy.skin === 'navy' && /gradient/.test(skins.navy.image) && skins.navy.image !== skins.balanced.image, skins);
        const bands = Object.values(skins).filter(x => x.band);
        c.check(`the response's header is a coloured band apart from the panes, in every skin (${bands.length} seen)`,
            bands.length === Object.keys(skins).length && bands.every(x => x.band !== x.pane && !/rgba\(0, 0, 0, 0\)/.test(x.band)), skins);

        // the colour mode: light, dark and system in a row of the menu; the product's colours follow on this page
        const modeOf = () => b.evaluate(`(() => { const h = document.documentElement;
            return { mode: h.getAttribute('data-color-mode'), auto: h.hasAttribute('data-color-mode-auto'),
                surface: getComputedStyle(document.querySelector('.rab-n')).getPropertyValue('--ds-surface').trim() }; })()`);
        const pickMode = async m => {
            if (!await b.evaluate(`!!document.querySelector('[data-testid=menu]')`)) await click('[data-testid=menu-button]');
            await b.waitFor(`!!document.querySelector('[data-testid=mode-${m}]')`, 3000);
            await click(`[data-testid=mode-${m}]`);
            await sleep(250);
            return { ...await modeOf(), pressed: await b.evaluate(`document.querySelector('[data-testid=mode-${m}]').getAttribute('aria-checked')`) };
        };
        const modes = { dark: await pickMode('dark'), light: await pickMode('light'), system: await pickMode('system') };
        // the Send button's text against the first colour of its fill (the lighter end of a gradient), per skin and mode
        const lum = c3 => { const [r, g, bl] = c3.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
            return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
        // computed colours come as rgb(r, g, b) or, for colour-mix results, as color(srgb r g b) with 0..1 channels
        const rgb = t => { const f = t.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/); if (f) return f.slice(1, 4).map(v => Number(v) * 255);
            return (t.match(/rgba?\(([^)]+)\)/) || [, ''])[1].split(',').slice(0, 3).map(Number); };
        const contrast = (a, z) => { const [x, y] = [lum(rgb(a)), lum(rgb(z))].sort((m, n) => n - m); return Math.round((x + 0.05) / (y + 0.05) * 100) / 100; };
        const sendColors = () => b.evaluate(`(() => { const s = document.querySelector('[data-testid=send]'); if (!s) return null; const st = getComputedStyle(s);
            return { color: st.color, fill: (st.backgroundImage.match(/(rgba?|color)\\([^)]*\\)/) || [st.backgroundColor])[0] }; })()`);
        const sends = {};
        for (const id of ['balanced', 'vivid', 'navy']) {
            await pickSkin(id);
            for (const m of ['light', 'dark']) {
                await pickMode(m);
                const sc = await sendColors();
                if (sc) sends[`${id}-${m}`] = { ...sc, ratio: contrast(sc.color, sc.fill) };
            }
        }
        await pickMode('system');
        await pickSkin('navy');
        await press('Escape');
        c.check(`Send's text keeps 4.5:1 against its fill in every skin, light and dark (${Object.keys(sends).length} seen)`,
            Object.keys(sends).length === 6 && Object.values(sends).every(x => x.ratio >= 4.5), sends);
        const theme = await b.evaluate(`document.documentElement.getAttribute('data-theme') || ''`);
        c.check('the page\'s data-theme gets dark:dark and light:light, nothing else', /dark:dark/.test(theme) && /light:light/.test(theme) && !/null/.test(theme), theme);
        // the request's and the response's tabs each point to their panel
        const panels = await b.evaluate(`[...document.querySelectorAll('.rab-n-request [role=tablist], .rab-n-response [role=tablist]')].map(l => {
            const t = l.querySelector('[role=tab][aria-selected=true]'); const pane = t && document.getElementById(t.getAttribute('aria-controls') || '');
            return { label: l.getAttribute('aria-label'), panel: pane ? pane.getAttribute('role') : null, labelledBy: pane && pane.getAttribute('aria-labelledby') === t.id }; })`);
        c.check('the request\'s and the response\'s tabs each point to their panel', panels.length === 2 && panels.every(x => x.label && x.panel === 'tabpanel' && x.labelledBy), panels);
        c.check('the menu switches light, dark and system: the product\'s colours follow on this page',
            modes.dark.mode === 'dark' && !modes.dark.auto && modes.light.mode === 'light' && !modes.light.auto
            && modes.dark.surface !== modes.light.surface && modes.system.auto
            && [modes.dark, modes.light, modes.system].every(x => x.pressed === 'true'), modes);

        // Escape in the search box clears it (and nothing else)
        await type('[data-testid=search]', 'no-such-words');
        await b.evaluate(`document.querySelector('[data-testid=search]').focus()`);
        await sleep(250);
        await press('Escape');
        await sleep(250);
        const cleared = await b.evaluate(`document.querySelector('[data-testid=search]').value`);
        c.check('Escape in the search box clears it', cleared === '', cleared);

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
        const prefilled = await b.waitFor(`(document.querySelector('input[name=' + ${q(q(P.param))} + ']') || {}).value === 'DEEP-1'`, 60000);
        const keptSkin = await b.waitFor(`document.querySelector('.rab-n').dataset.skin === 'navy'`, 5000);
        c.check('the chosen skin is kept after a reload', keptSkin, await skinOf());
        await pickSkin('balanced');
        const sent = await b.evaluate(`!!document.querySelector('[data-testid=response]')`);
        c.check('a deep link opens the operation with its values, without sending', prefilled && !sent, { prefilled, sent });

        // a link with parameters named like an object's built-in properties still opens the page
        await b.navigate(PAGE + '?op=' + encodeURIComponent(key) + '&q.toString=1&path.constructor=2&h.__proto__=3&valueOf=4');
        const odd = await b.waitFor(`!!document.querySelector('[data-testid=search]') && !!document.querySelector('[data-testid=operation]')`, 60000);
        c.check('a link with parameters named toString, constructor, __proto__ still opens the page and the operation', odd);

        // form parameters: an operation with a form parameter renders an enabled input and builds the body from it
        const formOp = await b.evaluate(`(async () => {
            const cat = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/catalog', { credentials: 'same-origin' })).json();
            const idx = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/catalog/index/' + cat.hash, { credentials: 'same-origin' })).json();
            const isTextFormParam = p => p.in === 'form' && p.type !== 'File' && p.type !== 'boolean' && !(p.options && p.options.length);
            const o = idx.operations.find(x => ['POST','PUT','PATCH','DELETE'].includes(x.method) && x.params.some(isTextFormParam));
            if (!o) return null;
            const fp = o.params.find(isTextFormParam);
            return { key: o.key, param: fp.name };
        })()`);
        if (formOp) {
            await b.navigate(PAGE + '?op=' + encodeURIComponent(formOp.key));
            const hasInput = await b.waitFor(`!!document.querySelector('input[name=${q(formOp.param)}]:not(:disabled), select[name=${q(formOp.param)}]:not(:disabled)')`, 30000);
            if (hasInput) {
                await type(`input[name=${q(formOp.param)}]`, 'test-value');
                await sleep(150);
                await b.evaluate(`([...document.querySelectorAll('.rab-n-request [role=tab]')].find(t => t.textContent.trim() === 'Body') || {}).click?.(), true`);
                const bodyNote = await b.waitFor(`!!document.querySelector('[data-testid=form-body-note]')`, 3000);
                const disabled = await b.evaluate(`!!document.querySelector('[data-testid=body]')?.disabled`);
                c.check(`form parameters render enabled inputs and drive the Body tab (${formOp.param})`, hasInput && bodyNote && disabled,
                    { formOp, hasInput, bodyNote, disabled });
            } else {
                c.check(`form parameters render enabled inputs (${formOp.param})`, false, formOp);
            }
        } else {
            console.log('SKIP no text form-parameter operation found in this catalog');
        }

        // Generate example DTO payload button in BodyTab (never sends the write request)
        const dtoOp = await b.evaluate(`(async () => {
            const cat = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/catalog', { credentials: 'same-origin' })).json();
            const idx = await (await fetch(${q(CONTEXT)} + '/rest/restbrowser/1/catalog/index/' + cat.hash, { credentials: 'same-origin' })).json();
            const o = idx.operations.find(x => ['POST', 'PUT'].includes(x.method) && (x.bodyType || x.bodyJavaType)
                && !x.params.some(p => p.in === 'form')
                && (!x.consumes || !x.consumes.length || x.consumes.some(c => /json/i.test(c))));
            return o ? { key: o.key, bodyType: o.bodyType || o.bodyJavaType } : null;
        })()`);
        if (dtoOp) {
            await b.navigate(PAGE + '?op=' + encodeURIComponent(dtoOp.key));
            await b.waitFor(`!!document.querySelector('.rab-n-request [role=tab]')`, 30000);
            await b.evaluate(`([...document.querySelectorAll('.rab-n-request [role=tab]')].find(t => t.textContent.trim() === 'Body') || {}).click?.(), true`);
            const hasGen = await b.waitFor(`!!document.querySelector('[data-testid=generate-example]')`, 3000);
            let genBody = '';
            if (hasGen) {
                await click('[data-testid=generate-example]');
                const filled = await b.waitFor(`((document.querySelector('[data-testid=body]') || {}).value || '').trim().length > 0`, 15000);
                if (filled) genBody = await b.evaluate(`document.querySelector('[data-testid=body]').value`);
            }
            c.check(`Body tab "Generate example" synthesizes a JSON example for ${dtoOp.bodyType}`, hasGen && genBody.trim().length > 0, { dtoOp, hasGen, len: genBody.length });
        } else {
            console.log('SKIP no JSON DTO body operation found for Generate example check');
        }

        // admin intro page: decorated entry page linked from Jira / Confluence administration
        await b.navigate(PAGE + '/admin');
        const adminIntroOk = await b.waitFor(`!!document.querySelector('#rab-admin-intro') && !!document.querySelector('#rab-open-fullscreen')`, 30000);
        const adminCheck = adminIntroOk ? await b.evaluate(`(() => {
            const cta = document.querySelector('#rab-open-fullscreen');
            const mcp = document.querySelector('#rab-mcp-config');
            const stuck = document.querySelector('#rab-prompt-stuck');
            const chrome = !!(document.querySelector('#header, #admin-nav, #admin-menu, .aui-header, .aui-page-panel-nav, .acs-side-bar'));
            return {
                ctaHref: cta ? cta.getAttribute('href') : null,
                ctaTarget: cta ? cta.getAttribute('target') : null,
                ctaWidth: cta ? Math.round(cta.getBoundingClientRect().width) : 0,
                mcpHasUrl: !!(mcp && mcp.textContent && mcp.textContent.includes('/rest/restbrowser/1/mcp')),
                stuckHasSteps: !!(stuck && stuck.textContent && stuck.textContent.includes('investigate_operation_context')),
                chrome,
            };
        })()`) : { error: 'admin intro not rendered' };
        c.check('administration intro page (/rest-api-browser/admin) renders product chrome, full-screen launch button, MCP config, and stuck-endpoint prompt',
            adminIntroOk && typeof adminCheck.ctaHref === 'string' && adminCheck.ctaHref.endsWith('/plugins/servlet/rest-api-browser')
            && adminCheck.ctaTarget === '_blank' && adminCheck.ctaWidth > 80 && adminCheck.mcpHasUrl && adminCheck.stuckHasSteps && adminCheck.chrome,
            adminCheck);
        await b.shot(path.join(SHOTS, `${PRODUCT}-admin-intro.png`));

        // errors
        const own = b.exceptions.filter(e => /next\.js|rest-api-browser|restbrowser/i.test(e));
        c.check('no JavaScript exception from the new UI', own.length === 0, own);
        // not the 404s/409s asked on purpose (a link to no such module, the request that starts a module, or 409 still-not-started), nor, while a
        // module starts, an index the catalog replaced meanwhile (the store asks again, by design)
        const ownFailed = b.failedRequests.filter((u, i) => /restbrowser|rest-api-browser/i.test(u) && !/op=no\.such%3Amodule/.test(u)
            && !/rest-api-browser-start/.test(u)
            && !(i >= startWindow[0] && i < startWindow[1] && (/^404 .*\/catalog\/index\//.test(u) || /^409 .*\/catalog\/started/.test(u))));
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
