// The REST API Browser page in headless Edge/Chrome against a REAL Jira or Confluence (the one of
// src/test/product/product.sh): the browser-side half of the smoke check, which smoke.py cannot see (Angular app,
// WADL loading, AUI on the product's page). Run it after smoke.py has installed the plugin.
//
//   node src/test/product/ui.js                            # http://localhost:2992/jira, admin/admin; shots in shots/
//   RAB_PRODUCT=confluence node src/test/product/ui.js     # http://localhost:1992/confluence
//   RAB_URL=... RAB_USER=... RAB_PASSWORD=... node src/test/product/ui.js
//   RAB_BROWSER="C:/path/to/msedge.exe" node src/test/product/ui.js
//   RAB_BROWSER_ARGS="--ignore-certificate-errors" node src/test/product/ui.js   # extra browser flags
//
// Needs Node 22+ (fetch, WebSocket) and Edge or Chrome; no npm packages (it speaks the DevTools protocol itself).
// Exit code: 0 all checks passed, 1 a check failed, 2 not run. The last line is "N checks, N passed, N failed".
const fs = require('fs'), path = require('path');
const { launch, checker, sleep } = require('./cdp');

// per product: its URL, a public resource of its core REST API to search for, select and send, and its answer; a
// resource with a path parameter, which is sent with a value that needs URL encoding (a read of nothing that exists)
const PRODUCTS = {
    jira: { name: 'Jira', url: 'http://localhost:2992/jira', core: /^api\/2\//, coreName: 'api/2',
        resource: 'serverInfo', answer: /"baseUrl"|"version"/,
        templated: 'api/2/issue/{issueIdOrKey}', templateParam: 'issueIdOrKey' },
    confluence: { name: 'Confluence', url: 'http://localhost:1992/confluence', core: /^api\//, coreName: 'api',
        resource: 'user/current', answer: /"username"|"userKey"/,
        templated: 'api/content/{id}', templateParam: 'id' },
};
const ODD_VALUE = 'no such?#%&$&', ODD_VALUE_ENCODED = 'no%20such%3F%23%25%26%24%26';
const PRODUCT = process.env.RAB_PRODUCT || 'jira', P = PRODUCTS[PRODUCT];
if (!P) { console.log(`ui.js: RAB_PRODUCT is ${Object.keys(PRODUCTS).join(' or ')}, not ${PRODUCT}`); process.exit(2); }
const BASE = (process.env.RAB_URL || P.url).replace(/\/$/, '');
const USER = process.env.RAB_USER || 'admin', PASS = process.env.RAB_PASSWORD || 'admin';
const OUT = path.join(__dirname, 'shots');
const c = checker();
const check = (name, ok, detail) => c.check(name, ok, detail);

(async () => {
    try {
        const r = await fetch(BASE + '/status');
        if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) {
        console.log(`ui.js: ${BASE} does not answer (${e.message}); start it with ${PRODUCT === 'jira' ? '' : 'RAB_PRODUCT=' + PRODUCT + ' '}src/test/product/product.sh start`);
        process.exit(2);
    }
    fs.mkdirSync(OUT, { recursive: true });

    let b;
    try {
        b = await launch({ user: USER, password: PASS });
    } catch (e) {
        console.log(`ui.js: ${e.message}`);
        process.exit(2);
    }
    try {
        const { send, evaluate, waitFor, exceptions, failedRequests } = b;
        const shot = name => b.shot(path.join(OUT, name + '.png'));
        const click = sel => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
        const sidebarCount = 'document.querySelectorAll("#searchTextResults li").length';
        const loaded = '(() => { const i = [...document.querySelectorAll("#rab i")].find(e => /all the APIs/.test(e.textContent)); return !!i && i.offsetParent !== null; })()';

        // ---- the page
        await send('Page.navigate', { url: BASE + '/plugins/servlet/restbrowser' });
        check('the page opens with the search field and the "public only" checkbox',
            await waitFor('!!document.querySelector("#searchField") && !!document.querySelector("#publicOnlyFilter")', 60000),
            await evaluate('location.href + " " + document.title'));
        check('Angular bootstrapped the app (window.angular and the RAB module)',
            await waitFor('!!window.angular && !!angular.element(document.querySelector("#rab")).scope()', 20000));
        check(`${P.name}'s decorator wraps the page (${P.name} header present)`,
            await evaluate('!!document.querySelector("#header, header#header, .aui-header")'));

        // ---- the sidebar with only the public APIs (the default, as RestApiBrowserSmokeTest checks)
        check('"Show only public APIs" is checked by default', await evaluate('document.querySelector("#publicOnlyFilter").checked'));
        const publicLoaded = await waitFor(loaded, 90000);
        const publicCount = await evaluate(sidebarCount);
        const publicNames = await evaluate('[...document.querySelectorAll("#searchTextResults li a")].map(a => a.textContent)');
        check('the public APIs are loaded into the sidebar', publicLoaded && publicCount > 0, { publicLoaded, publicCount });
        check(`the public list has ${P.name}'s ${P.coreName} resources`, (publicNames || []).some(n => P.core.test(n)), (publicNames || []).slice(0, 5));
        console.log(`Public resources in the sidebar: ${publicCount}`);
        await shot(PRODUCT + '-1-public-apis');

        // ---- all APIs (unchecking the box loads the other WADLs)
        await click('#publicOnlyFilter');
        check('the checkbox can be unchecked (RestApiBrowserSmokeTest)', await evaluate('!document.querySelector("#publicOnlyFilter").checked'));
        await sleep(500);
        const allLoaded = await waitFor(loaded, 120000);
        const allCount = await evaluate(sidebarCount);
        check('all APIs load and the list grows', allLoaded && allCount > publicCount, { allLoaded, allCount, publicCount });
        console.log(`All resources in the sidebar: ${allCount}`);
        await shot(PRODUCT + '-2-all-apis');

        // ---- search
        await evaluate(`(() => { const s = document.querySelector("#searchField"); s.value = ${JSON.stringify(P.resource)};
            s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
        await sleep(800);
        const found = await evaluate('[...document.querySelectorAll("#searchTextResults li a")].map(a => a.textContent)');
        check(`searching "${P.resource}" narrows the list to it`, found && found.length > 0 && found.length < allCount
            && found.some(n => n.toLowerCase().endsWith(P.resource.toLowerCase())), (found || []).slice(0, 5));

        // ---- a resource: its methods and the form to try one
        await click(`#searchTextResults li a[title$=${JSON.stringify(P.resource)}], #searchTextResults li a`);
        const shown = await waitFor(`(() => { const v = document.querySelector("[ng-view]"); return !!v && /GET/.test(v.textContent)
            && v.textContent.toLowerCase().includes(${JSON.stringify(P.resource.toLowerCase())}); })()`, 20000);
        check(`selecting ${P.coreName}/${P.resource} shows its GET method`, shown, await evaluate('(document.querySelector("[ng-view]") || {}).textContent?.slice(0, 300)'));
        await shot(PRODUCT + '-3-resource');
        // the "Send" button of the first method runs the request from the browser
        const sent = await evaluate(`(() => { const b = [...document.querySelectorAll("[ng-view] button, [ng-view] input[type=submit]")]
            .find(e => /send|execute|try/i.test(e.textContent || e.value)); if (!b) return false; b.click(); return true; })()`);
        if (sent) {
            const answered = await waitFor(`${P.answer}.test((document.querySelector("[ng-view]") || {}).textContent || "")`, 20000);
            check(`sending GET ${P.coreName}/${P.resource} from the page shows ${P.name}'s answer`, answered,
                await evaluate('(document.querySelector("[ng-view]") || {}).textContent?.slice(0, 400)'));
            await shot(PRODUCT + '-4-response');
        } else {
            console.log('SKIP sending a request: no Send button found in the resource view');
        }

        // opens a resource by its exact name: search for it, then click it (the view gets its resource from the list)
        const openResource = async name => {
            await evaluate(`(() => { const s = document.querySelector("#searchField"); s.value = ${JSON.stringify(name)};
                s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
            await sleep(800);
            if (!await click(`#searchTextResults li a[title=${JSON.stringify(name)}]`)) return false;
            return waitFor(`(() => { const h = document.querySelector("[ng-view] .rab-resource-title");
                return !!h && h.textContent.trim().startsWith(${JSON.stringify(name)}); })()`, 20000);
        };

        // ---- the resource's own description (the WADL's doc of the resource; 4.1.1 and earlier never showed it).
        // Jira 11's WADLs document no resource at all: then the check gives the core resource a description in the
        // page (nothing is sent) and checks that the view shows it.
        const described = await evaluate(`(() => {
            const all = angular.element(document.querySelector("#rab")).scope().resources || [];
            const has = r => r.description && r.description.trim().length >= 20;
            let r = all.find(r => has(r) && ${P.core}.test(r.name)) || all.find(has), set = false;
            if (!r) {
                r = all.find(r => ${P.core}.test(r.name) && r.name.endsWith(${JSON.stringify(P.resource)}));
                if (r) { r.description = "Description set by ui.js: no WADL here documents its resources."; set = true; }
            }
            return r ? { name: r.name, set, text: r.description.replace(/\\s+/g, " ").trim().slice(0, 60) } : null; })()`);
        if (!described) {
            console.log('SKIP the resource description: no resource to show one on');
        } else {
            const label = `the view shows the description of ${described.name}${described.set ? ' (set by the check)' : ''}`;
            if (await openResource(described.name)) {
                const shownText = await waitFor(`(() => { const p = document.querySelector("[ng-view] .rab-resource-description");
                    return !!p && p.offsetParent !== null && p.textContent.replace(/\\s+/g, " ").includes(${JSON.stringify(described.text)}); })()`, 10000);
                check(label, shownText, described.text);
            } else {
                check(label, false, 'could not open the resource');
            }
        }

        // ---- a path parameter's value is URL encoded (4.1.1 and earlier put it into the URL as typed)
        if (!await openResource(P.templated)) {
            console.log(`SKIP the path parameter: ${P.templated} is not in the list`);
        } else {
            const pane = '[ng-view] .tabs-pane.active-pane';
            const filled = await evaluate(`(() => { const i = document.querySelector(${JSON.stringify(pane + ' input[name="' + P.templateParam + '"]')});
                if (!i) return false; i.value = ${JSON.stringify(ODD_VALUE)}; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
            const method = await evaluate(`(document.querySelector(${JSON.stringify(pane)}) || {}).id`);
            // only ever a GET: the value names nothing that exists, but a write on a shared instance is not a test
            if (filled && method === 'GET' && await click(pane + ' button.aui-button-primary')) {
                const called = await waitFor(`/\\(\\d+\\)$/.test(((document.querySelector(${JSON.stringify(pane + ' .rab-resp code')}) || {}).textContent || "").trim())`, 20000);
                const call = await evaluate(`((document.querySelector(${JSON.stringify(pane + ' .rab-resp code')}) || {}).textContent || "").trim()`);
                check(`GET ${P.templated} with ${JSON.stringify(ODD_VALUE)} requests the encoded value`,
                    called && call.includes('/' + ODD_VALUE_ENCODED + ' ('), call);
                await shot(PRODUCT + '-5-path-parameter');
            } else {
                check(`GET ${P.templated} with a path parameter can be sent`, false, { filled, method });
            }
        }

        // ---- errors
        const ownErrors = exceptions.filter(e => /rest-api-browser|restbrowser|\brab\b/i.test(e));
        check('no JavaScript exception from the plugin\'s scripts', ownErrors.length === 0, ownErrors);
        exceptions.filter(e => !ownErrors.includes(e)).forEach(e => console.log('WARN JavaScript exception (not the plugin\'s): ' + e));
        const ownFailures = failedRequests.filter(u => /rest-api-browser|restbrowser|devtools/i.test(u));
        check('no failed request for the plugin\'s own resources', ownFailures.length === 0, ownFailures.slice(0, 10));
        // a WADL is the product's (or an app's) to serve: some refuse in some setups, e.g. OAuth 2.0 needs HTTPS outside
        // dev mode. Like smoke.py, at least 95% have to load.
        const wadlRequests = Object.values(b.requests).filter(u => /application\.wadl/.test(u)).length;
        const wadlFailures = failedRequests.filter(u => /application\.wadl/.test(u) && !ownFailures.includes(u));
        check(`at least 95% of the WADLs load (${wadlRequests - wadlFailures.length} of ${wadlRequests})`,
            wadlRequests > 0 && wadlFailures.length <= 0.05 * wadlRequests, wadlFailures.slice(0, 10));
        failedRequests.filter(u => !ownFailures.includes(u)).forEach(u => console.log('WARN failed request: ' + u));
        console.log(`Screenshots: ${OUT}`);
    } catch (e) {
        check('the browser run completed', false, String(e && e.stack || e));
    } finally {
        await b.close();
    }
    process.exit(c.finish());
})();
