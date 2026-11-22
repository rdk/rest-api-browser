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
        templated: 'api/2/issue/{issueIdOrKey}', param: 'issueIdOrKey' },
    confluence: { url: 'http://localhost:1992/confluence', search: 'user current', title: 'api/user/current', answer: /"username"|"userKey"|"type"/,
        templated: 'api/content/{id}', param: 'id' },
};
const PRODUCT = process.env.RAB_PRODUCT || 'jira', P = PRODUCTS[PRODUCT];
if (!P) { console.log(`ui_next.js: RAB_PRODUCT is ${Object.keys(PRODUCTS).join(' or ')}, not ${PRODUCT}`); process.exit(2); }
const BASE = (process.env.RAB_URL || P.url).replace(/\/$/, '');
const USER = process.env.RAB_USER || 'admin', PASS = process.env.RAB_PASSWORD || 'admin';
const PAGE = BASE + '/plugins/servlet/restbrowser/next';
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
    const openOp = async (search, title, method = 'GET') => {
        const row = `[data-testid=op][data-method=${method}][title=${q(title)}]`;
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

        // search: a flat, ranked list
        const searchStart = Date.now();
        await type('[data-testid=search]', P.search);
        const found = await b.waitFor(`!!document.querySelector('[data-testid=op][title=${q(P.title)}]')`, 5000);
        c.check(`searching "${P.search}" lists ${P.title}`, found, await b.evaluate(
            `[...document.querySelectorAll('[data-testid=op]')].slice(0, 5).map(e => e.title)`));
        console.log(`Search answered in ${Date.now() - searchStart} ms (including the poll)`);

        // the operation: form, live URL, send, response
        c.check(`opening ${P.title} shows its form`, await openOp(P.search, P.title));
        const url = await text('[data-testid=live-url]');
        c.check('the live URL ends with the operation path', url.endsWith('/rest/' + P.title), url);
        await click('[data-testid=send]');
        const answered = await b.waitFor(`${P.answer}.test((document.querySelector('[data-testid=response]') || {}).textContent || '')`, 20000);
        c.check(`Send shows the product's answer (status ${(await text('[data-testid=response-status]')).trim()})`, answered,
            (await text('[data-testid=response]')).slice(0, 200));
        await b.shot(path.join(SHOTS, `${PRODUCT}-next-2-response.png`));
        c.check('the History tab lists the request', await b.waitFor(`/History \\([1-9]/.test(document.body.textContent)`, 5000));

        // a path parameter's value is URL-encoded; the request is a GET of something that cannot exist
        if (await openOp(P.templated.split('/').slice(-2).join(' ').replace(/[{}]/g, ''), P.templated)) {
            await type(`input[name=${q(P.param)}]`, ODD);
            const live = await text('[data-testid=live-url]');
            c.check('the live URL carries the path value URL-encoded', live.includes('/' + ODD_ENCODED), live);
            const method = await b.evaluate(`(document.querySelector('[data-testid=send]') || {}).textContent || ''`);
            if (/GET/.test(method)) {
                await click('[data-testid=send]');
                const st = await b.waitFor(`/\\d{3}/.test((document.querySelector('[data-testid=response-status]') || {}).textContent || '')`, 20000);
                c.check('the GET with the odd value gets an answer', st, (await text('[data-testid=response-status]')).trim());
            }
        } else {
            console.log(`SKIP the path parameter: ${P.templated} is not in the list`);
        }

        // supported only narrows the list
        await type('[data-testid=search]', '');
        const before = await b.evaluate(`(document.querySelector('[data-testid=status]') || {}).textContent || ''`);
        await click('[data-testid=supported-only]');
        await sleep(300);
        const after = await text('[data-testid=status]');
        c.check('"Supported only" narrows the operations', /of/.test(after) && after !== before, { before, after });
        await click('[data-testid=supported-only]');

        // a deep link fills the form and sends nothing
        const key = await b.evaluate(`new URLSearchParams(location.search).get('op')`);
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
