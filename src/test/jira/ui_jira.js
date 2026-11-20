// The REST API Browser page in headless Edge/Chrome against a REAL Jira (the Jira of src/test/jira/jira.sh): the
// browser-side half of the smoke check, which smoke_jira.py cannot see (Angular app, WADL loading, AUI on Jira's
// page). Run it after smoke_jira.py has installed the plugin.
//
//   node src/test/jira/ui_jira.js                 # http://localhost:2992/jira, admin/admin; screenshots in src/test/jira/shots/
//   JIRA_URL=... JIRA_USER=... JIRA_PASSWORD=... node src/test/jira/ui_jira.js
//   RAB_BROWSER="C:/path/to/msedge.exe" node src/test/jira/ui_jira.js
//
// Needs Node 22+ (fetch, WebSocket) and Edge or Chrome; no npm packages (it speaks the DevTools protocol itself).
// Exit code: 0 all checks passed, 1 a check failed, 2 not run. The last line is "N checks, N passed, N failed".
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

const BASE = (process.env.JIRA_URL || 'http://localhost:2992/jira').replace(/\/$/, '');
const USER = process.env.JIRA_USER || 'admin', PASS = process.env.JIRA_PASSWORD || 'admin';
const OUT = path.join(__dirname, 'shots');
const BROWSERS = [
    process.env.RAB_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
    results.push([name, !!ok]);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 400)));
    return !!ok;
}

(async () => {
    const exe = BROWSERS.find(p => fs.existsSync(p));
    if (!exe) { console.log('ui_jira.js: no Edge or Chrome found (set RAB_BROWSER)'); process.exit(2); }
    try {
        const r = await fetch(BASE + '/status');
        if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) {
        console.log(`ui_jira.js: ${BASE} does not answer (${e.message}); start it with src/test/jira/jira.sh start`);
        process.exit(2);
    }
    fs.mkdirSync(OUT, { recursive: true });

    const port = 9400 + Math.floor(Math.random() * 500);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rab-jira-ui-'));
    const browser = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + profile,
        '--remote-debugging-port=' + port, '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });
    let ws;
    try {
        let target;
        for (let i = 0; i < 80 && !target; i++) {
            try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch (e) { /* starting */ }
            if (!target) await sleep(250);
        }
        if (!target) throw new Error('the browser did not open its DevTools port');
        ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

        let id = 0;
        const pending = {}, exceptions = [], failedRequests = [], requests = {};
        const authHeader = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
        ws.onmessage = m => {
            const d = JSON.parse(m.data);
            if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; return; }
            if (d.method === 'Runtime.exceptionThrown') {
                const ex = d.params.exceptionDetails;
                exceptions.push(((ex.exception && ex.exception.description) || ex.text || '').split('\n')[0] + ' @ ' + (ex.url || ''));
            } else if (d.method === 'Fetch.requestPaused') {
                // Basic credentials only on the page and its XHRs (the WADLs): static web resources are public, and
                // Basic auth on every resource request makes Jira's decorator drop the session mid-response
                const p = d.params;
                const headers = Object.entries(p.request.headers).map(([name, value]) => ({ name, value }));
                if (['Document', 'XHR', 'Fetch'].includes(p.resourceType)) headers.push({ name: 'Authorization', value: authHeader });
                ws.send(JSON.stringify({ id: ++id, method: 'Fetch.continueRequest', params: { requestId: p.requestId, headers } }));
            } else if (d.method === 'Network.requestWillBeSent') {
                requests[d.params.requestId] = d.params.request.url;
            } else if (d.method === 'Network.responseReceived') {
                const r = d.params.response;
                if (r.status >= 400) failedRequests.push(r.status + ' ' + r.url);
            } else if (d.method === 'Network.loadingFailed' && !d.params.canceled) {
                failedRequests.push(d.params.errorText + ' ' + (requests[d.params.requestId] || ''));
            }
        };
        const send = (method, params = {}) => new Promise(res => { const i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method, params })); });
        const evaluate = async expr => {
            const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
            return r.result && r.result.result ? r.result.result.value : undefined;
        };
        const waitFor = async (expr, ms = 30000) => {
            const end = Date.now() + ms;
            while (Date.now() < end) { if (await evaluate(expr)) return true; await sleep(250); }
            return false;
        };
        const shot = async name => {
            const r = await send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
        };
        const click = sel => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
        const sidebarCount = 'document.querySelectorAll("#searchTextResults li").length';
        const loaded = '(() => { const i = [...document.querySelectorAll("#rab i")].find(e => /all the APIs/.test(e.textContent)); return !!i && i.offsetParent !== null; })()';

        await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
        await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

        // ---- the page
        await send('Page.navigate', { url: BASE + '/plugins/servlet/restbrowser' });
        check('the page opens with the search field and the "public only" checkbox',
            await waitFor('!!document.querySelector("#searchField") && !!document.querySelector("#publicOnlyFilter")', 60000),
            await evaluate('location.href + " " + document.title'));
        check('Angular bootstrapped the app (window.angular and the RAB module)',
            await waitFor('!!window.angular && !!angular.element(document.querySelector("#rab")).scope()', 20000));
        check('Jira\'s decorator wraps the page (Jira header present)',
            await evaluate('!!document.querySelector("#header, header#header, .aui-header")'));

        // ---- the sidebar with only the public APIs (the default, as RestApiBrowserSmokeTest checks)
        check('"Show only public APIs" is checked by default', await evaluate('document.querySelector("#publicOnlyFilter").checked'));
        const publicLoaded = await waitFor(loaded, 90000);
        const publicCount = await evaluate(sidebarCount);
        const publicNames = await evaluate('[...document.querySelectorAll("#searchTextResults li a")].map(a => a.textContent)');
        check('the public APIs are loaded into the sidebar', publicLoaded && publicCount > 0, { publicLoaded, publicCount });
        check('the public list has Jira\'s api/2 resources', (publicNames || []).some(n => /^api\/2\//.test(n)), (publicNames || []).slice(0, 5));
        console.log(`Public resources in the sidebar: ${publicCount}`);
        await shot('1-public-apis');

        // ---- all APIs (unchecking the box loads the other WADLs)
        await click('#publicOnlyFilter');
        check('the checkbox can be unchecked (RestApiBrowserSmokeTest)', await evaluate('!document.querySelector("#publicOnlyFilter").checked'));
        await sleep(500);
        const allLoaded = await waitFor(loaded, 120000);
        const allCount = await evaluate(sidebarCount);
        check('all APIs load and the list grows', allLoaded && allCount > publicCount, { allLoaded, allCount, publicCount });
        console.log(`All resources in the sidebar: ${allCount}`);
        await shot('2-all-apis');

        // ---- search
        await evaluate(`(() => { const s = document.querySelector("#searchField"); s.value = "serverInfo";
            s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
        await sleep(800);
        const found = await evaluate('[...document.querySelectorAll("#searchTextResults li a")].map(a => a.textContent)');
        check('searching "serverInfo" narrows the list to it', found && found.length > 0 && found.length < allCount
            && found.some(n => /serverInfo/i.test(n)), (found || []).slice(0, 5));

        // ---- a resource: its methods and the form to try one
        await click('#searchTextResults li a[title$="serverInfo"], #searchTextResults li a');
        const shown = await waitFor('(() => { const v = document.querySelector("[ng-view]"); return !!v && /GET/.test(v.textContent) && /serverInfo/i.test(v.textContent); })()', 20000);
        check('selecting api/2/serverInfo shows its GET method', shown, await evaluate('(document.querySelector("[ng-view]") || {}).textContent?.slice(0, 300)'));
        await shot('3-serverinfo');
        // the "Send" button of the first method runs the request from the browser
        const sent = await evaluate(`(() => { const b = [...document.querySelectorAll("[ng-view] button, [ng-view] input[type=submit]")]
            .find(e => /send|execute|try/i.test(e.textContent || e.value)); if (!b) return false; b.click(); return true; })()`);
        if (sent) {
            const answered = await waitFor('/"baseUrl"|"version"/.test((document.querySelector("[ng-view]") || {}).textContent || "")', 20000);
            check('sending GET api/2/serverInfo from the page shows Jira\'s answer', answered,
                await evaluate('(document.querySelector("[ng-view]") || {}).textContent?.slice(0, 400)'));
            await shot('4-serverinfo-response');
        } else {
            console.log('SKIP sending a request: no Send button found in the resource view');
        }

        // ---- errors
        const ownErrors = exceptions.filter(e => /rest-api-browser|restbrowser|\brab\b/i.test(e));
        check('no JavaScript exception from the plugin\'s scripts', ownErrors.length === 0, ownErrors);
        exceptions.filter(e => !ownErrors.includes(e)).forEach(e => console.log('WARN JavaScript exception (not the plugin\'s): ' + e));
        const ownFailures = failedRequests.filter(u => /rest-api-browser|restbrowser|application\.wadl|devtools/i.test(u));
        check('no failed request for the plugin\'s resources or the WADLs', ownFailures.length === 0, ownFailures.slice(0, 10));
        failedRequests.filter(u => !ownFailures.includes(u)).forEach(u => console.log('WARN failed request: ' + u));
        console.log(`Screenshots: ${OUT}`);
    } catch (e) {
        check('the browser run completed', false, String(e && e.stack || e));
    } finally {
        try { ws && ws.close(); } catch (e) { /* closed */ }
        browser.kill();
        await sleep(500);
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* the browser may still hold it */ }
    }
    const failed = results.filter(r => !r[1]).length;
    console.log(`${results.length} checks, ${results.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
