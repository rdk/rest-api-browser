// A minimal headless Edge/Chrome driver over the DevTools protocol (no npm packages), for the browser checks.
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

const BROWSERS = [
    process.env.RAB_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const EXTRA_ARGS = (process.env.RAB_BROWSER_ARGS || '').split(/\s+/).filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Starts a headless browser that sends Basic credentials with the page and its XHR/fetch requests (static web
 * resources are public; Basic auth on all of them makes some decorators drop the session).
 */
async function launch({ user, password, width = 1500, height = 1000 }) {
    const exe = BROWSERS.find(p => fs.existsSync(p));
    if (!exe) throw new Error('no Edge or Chrome found (set RAB_BROWSER)');
    const port = 9400 + Math.floor(Math.random() * 500);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rab-cdp-'));
    const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + profile,
        '--remote-debugging-port=' + port, `--window-size=${width},${height}`, ...EXTRA_ARGS, 'about:blank'], { stdio: 'ignore' });
    let target;
    for (let i = 0; i < 80 && !target; i++) {
        try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch (e) { /* starting */ }
        if (!target) await sleep(250);
    }
    if (!target) { proc.kill(); throw new Error('the browser did not open its DevTools port'); }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = {};
    const b = { exceptions: [], failedRequests: [], requests: {} };
    const auth = 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
    ws.onmessage = m => {
        const d = JSON.parse(m.data);
        if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; return; }
        if (d.method === 'Runtime.exceptionThrown') {
            const ex = d.params.exceptionDetails;
            b.exceptions.push(((ex.exception && ex.exception.description) || ex.text || '').split('\n')[0] + ' @ ' + (ex.url || ''));
        } else if (d.method === 'Fetch.requestPaused') {
            const p = d.params;
            const headers = Object.entries(p.request.headers).map(([name, value]) => ({ name, value }));
            if (['Document', 'XHR', 'Fetch'].includes(p.resourceType)) headers.push({ name: 'Authorization', value: auth });
            ws.send(JSON.stringify({ id: ++id, method: 'Fetch.continueRequest', params: { requestId: p.requestId, headers } }));
        } else if (d.method === 'Network.requestWillBeSent') {
            b.requests[d.params.requestId] = d.params.request.url;
        } else if (d.method === 'Network.responseReceived') {
            const r = d.params.response;
            if (r.status >= 400) b.failedRequests.push(r.status + ' ' + r.url);
        } else if (d.method === 'Network.loadingFailed' && !d.params.canceled) {
            b.failedRequests.push(d.params.errorText + ' ' + (b.requests[d.params.requestId] || ''));
        }
    };
    b.send = (method, params = {}) => new Promise(res => { const i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method, params })); });
    b.evaluate = async expr => {
        const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        return r.result && r.result.result ? r.result.result.value : undefined;
    };
    b.waitFor = async (expr, ms = 30000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await b.evaluate(expr)) return true; await sleep(200); }
        return false;
    };
    b.shot = async file => {
        const r = await b.send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    };
    b.navigate = url => b.send('Page.navigate', { url });
    b.close = async () => {
        try { ws.close(); } catch (e) { /* closed */ }
        proc.kill();
        await sleep(500);
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* the browser may still hold it */ }
    };
    await b.send('Runtime.enable'); await b.send('Page.enable'); await b.send('Network.enable');
    await b.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    return b;
}

/** Collects PASS/FAIL lines like smoke.py; finish() prints the summary and returns the exit code. */
function checker() {
    const results = [];
    return {
        check(name, ok, detail) {
            results.push([name, !!ok]);
            console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 400)));
            return !!ok;
        },
        finish() {
            const failed = results.filter(r => !r[1]).length;
            console.log(`${results.length} checks, ${results.length - failed} passed, ${failed} failed`);
            return failed ? 1 : 0;
        },
    };
}

module.exports = { launch, checker, sleep };
