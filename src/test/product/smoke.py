#!/usr/bin/env python3
"""Smoke check of the REST API Browser (RAB) on a real Jira or Confluence: installs the plugin jar through UPM and
checks it over HTTP.

    python src/test/product/smoke.py --expect-version 11.3.13     # newest target/rest-api-browser-*.jar
    python src/test/product/smoke.py --jar target/rest-api-browser-4.0.0-SNAPSHOT.jar
    python src/test/product/smoke.py --no-install                 # check what is installed
    python src/test/product/smoke.py --uninstall                  # remove the plugin at the end
    python src/test/product/smoke.py --product confluence --expect-version 10.2.20

Settings: RAB_PRODUCT or --product (jira, the default, or confluence), RAB_URL or --url (default
http://localhost:2992/jira, or http://localhost:1992/confluence: the instance of src/test/product/product.sh),
RAB_USER / RAB_PASSWORD (default admin/admin) or --user / --password. It installs a plugin, so it refuses a host other
than localhost unless --allow-remote. Python 3.9+, standard library only.

Exit code: 0 all checks passed (WARN and SKIP lines do not count), 1 a check failed, 2 not run (product not
reachable, not authorized, no jar). The last line is "N checks, N passed, N failed".
"""
import argparse
import base64
import glob
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
import zipfile

PLUGIN_KEY = 'com.atlassian.labs.rest-api-browser'
SERVLET = '/plugins/servlet/restbrowser'
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
# per product: the URL of the product.sh instance, a REST resource that needs a login, the core REST API, the main log
# under AMPS's target directory (AMPS's Confluence logs to the console, which AMPS writes to confluence-LATEST.log)
PRODUCTS = {
    'jira': {'name': 'Jira', 'url': 'http://localhost:2992/jira', 'myself': '/rest/api/2/myself',
             'core': '/rest/api/2', 'log': ('jira', 'home', 'log', 'atlassian-jira.log')},
    'confluence': {'name': 'Confluence', 'url': 'http://localhost:1992/confluence', 'myself': '/rest/api/user/current',
                   'core': '/rest/api', 'log': ('confluence-LATEST.log',)},
}

results = []
warnings = []
skipped = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond or detail == '' else '  -> ' + str(detail)[:600]))
    return bool(cond)


def warn(text):
    warnings.append(text)
    print('WARN ' + text)


def skip(name, reason):
    skipped.append(name)
    print('SKIP %s: %s' % (name, reason))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Instance:
    def __init__(self, url, user, password):
        self.url = url.rstrip('/')
        self.auth = 'Basic ' + base64.b64encode(('%s:%s' % (user, password)).encode()).decode()
        self.opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor())
        self.anon_opener = urllib.request.build_opener(NoRedirect)

    def call(self, method, path, body=None, headers=None, auth=True, timeout=60):
        """(status, body text, headers dict with lower-case keys); never raises for an HTTP status."""
        url = path if path.startswith('http') else self.url + path
        h = {'Accept': '*/*'}
        if auth:
            h['Authorization'] = self.auth
        h.update(headers or {})
        req = urllib.request.Request(url, data=body, headers=h, method=method)
        try:
            with (self.opener if auth else self.anon_opener).open(req, timeout=timeout) as r:
                return r.status, r.read().decode('utf-8', 'replace'), {k.lower(): v for k, v in r.headers.items()}
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode('utf-8', 'replace'), {k.lower(): v for k, v in e.headers.items()}
        except (urllib.error.URLError, OSError) as e:
            if not url.startswith(self.url):
                return 0, str(e), {}  # another host (a URL on the page): a failed check, not a crash
            raise

    def json(self, path, accept='application/json', **kw):
        s, text, h = self.call('GET', path, headers={'Accept': accept}, **kw)
        try:
            return s, json.loads(text) if text else None, h
        except ValueError:
            return s, None, h


def jar_version(jar):
    try:
        with zipfile.ZipFile(jar) as z:
            xml = z.read('atlassian-plugin.xml').decode('utf-8', 'replace')
    except (OSError, KeyError, zipfile.BadZipFile):
        return None
    m = re.search(r'<plugin-info>.*?<version>([^<]+)</version>', xml, re.S)
    return m.group(1).strip() if m else None


def is_wadl(body):
    """A WADL document: <application>, with or without a namespace prefix (Jersey writes <ns2:application>)."""
    return bool(re.search(r'<(?:[\w-]+:)?application[\s>]', body or ''))


def bundled_file(jar, name):
    """A text file of the plugin jar (or of src/main/resources without a jar), None when neither has it."""
    try:
        if jar:
            with zipfile.ZipFile(jar) as z:
                return z.read(name).decode('utf-8', 'replace')
        with open(os.path.join(PROJECT, 'src', 'main', 'resources', name), encoding='utf-8') as f:
            return f.read()
    except (OSError, KeyError, zipfile.BadZipFile):
        return None


def plugin_info(j):
    # UPM answers 406 to Accept: application/json here; it wants its own media type
    s, info, _ = j.json('/rest/plugins/1.0/%s-key' % PLUGIN_KEY, accept='application/vnd.atl.plugins.plugin+json')
    return info if s == 200 and isinstance(info, dict) else None


def upm_token(j):
    s, _, h = j.call('GET', '/rest/plugins/1.0/?os_authType=basic',
                     headers={'Accept': 'application/vnd.atl.plugins.installed+json'})
    return h.get('upm-token') if s == 200 else None


def install(j, jar):
    token = upm_token(j)
    if not check('UPM answers and hands out an upm-token', token):
        return False
    boundary = uuid.uuid4().hex
    with open(jar, 'rb') as f:
        content = f.read()
    body = (('--%s\r\nContent-Disposition: form-data; name="plugin"; filename="%s"\r\n'
             'Content-Type: application/java-archive\r\n\r\n') % (boundary, os.path.basename(jar))).encode() \
        + content + ('\r\n--%s--\r\n' % boundary).encode()
    s, text, _ = j.call('POST', '/rest/plugins/1.0/?token=' + urllib.parse.quote(token), body=body,
                        headers={'Content-Type': 'multipart/form-data; boundary=' + boundary}, timeout=300)
    if not check('UPM accepts the upload', s in (200, 202), (s, text[:300])):
        if 'via upload' in text:
            print('  UPM disables uploads outside dev mode: start the product with -Dupm.plugin.upload.enabled=true '
                  '(product.sh does with RAB_DEV_MODE=false), or use --no-install')
        return False
    want = jar_version(jar)
    info, same_other = None, 0
    for _ in range(150):  # enabling a freshly uploaded plugin can take a few minutes on a cold instance
        time.sleep(2)
        info = plugin_info(j)
        if info and info.get('enabled') and (want is None or info.get('version') == want):
            return check('plugin %s is installed and enabled' % (want or ''), True)
        # the product keeps the higher version of a plugin key and drops a lower upload while UPM reports success
        same_other = same_other + 1 if info and info.get('enabled') else 0
        if same_other >= 30:
            break
    got = info.get('version') if info else None
    if want and got and got != want:
        return check('plugin %s is installed and enabled' % want, False,
                     'it runs version %s, not the jar\'s %s: the product keeps the higher version of a plugin key, '
                     'run with --uninstall once (or uninstall it in Manage apps) and again' % (got, want))
    return check('plugin %s is installed and enabled' % (want or ''), False,
                 'not enabled after 5 minutes: %s' % ({k: info.get(k) for k in ('enabled', 'version')} if info else 'not installed'))


def uninstall(j):
    s, text, _ = j.call('DELETE', '/rest/plugins/1.0/%s-key' % PLUGIN_KEY, headers={'X-Atlassian-Token': 'no-check'})
    check('plugin uninstalled through UPM', s in (200, 204), (s, text[:200]))


def default_jar():
    jars = [p for p in glob.glob(os.path.join(PROJECT, 'target', 'rest-api-browser-*.jar'))
            if not re.search(r'-(sources|tests|javadoc)\.jar$', p)]
    return max(jars, key=os.path.getmtime) if jars else None


def product_log_path(j, version, product):
    """atlassian-jira.log (confluence-LATEST.log) of the product.sh instance, when it is on this machine."""
    port = urllib.parse.urlparse(j.url).port or 80
    workdir = os.environ.get('RAB_WORKDIR') or os.path.join(os.path.expanduser('~'),
                                                             '%s-rab-%s-%s' % (product, version, port))
    p = os.path.join(workdir, 'amps-standalone-%s-%s' % (product, version), 'target',
                     *PRODUCTS[product]['log'])
    return p if os.path.isfile(p) else None


def wait_complete(j, seconds=120):
    """Poll the catalog summary every 2 s until it is complete: (summary or None, headers of the last answer)."""
    summary, h = None, {}
    deadline = time.time() + seconds
    while True:
        s, summary, h = j.json('/rest/restbrowser/1/catalog')
        if s == 200 and isinstance(summary, dict) and summary.get('complete'):
            return summary, h
        if time.time() >= deadline:
            return None, h
        time.sleep(2)


def norm_path(path):
    """A path with its templates (also {name: regex}) as {}, one leading slash, none trailing."""
    path = re.sub(r'\{[^{}]*\}', '{}', path or '')
    return '/' + re.sub(r'/+', '/', path).strip('/')


def wadl_operations(text):
    """The set of (method, normalized path) of a WADL: resources/resource walked recursively, path attributes joined."""
    ops = set()

    def local(e):
        return e.tag.rsplit('}', 1)[-1]

    def walk(e, base):
        for c in e:
            if local(c) == 'resource':
                p = base + '/' + (c.get('path') or '')
                for m in c:
                    if local(m) == 'method' and m.get('name'):
                        ops.add((m.get('name').upper(), norm_path(p)))
                walk(c, p)
            elif local(c) == 'resources':
                walk(c, base)

    walk(ET.fromstring(text), '')
    return ops


def new_ui(j, a, P):
    """The new UI (servlet /rest-api-browser) and its catalog REST API (/rest/restbrowser/1/catalog)."""
    NEXT = '/plugins/servlet/rest-api-browser'
    API = '/rest/restbrowser/1/catalog'
    s_leg, _, h_leg = j.call('GET', SERVLET + '/next?os_authType=basic', headers={'Accept': 'text/html'})
    check('legacy GET %s/next redirects to %s' % (SERVLET, NEXT),
          s_leg in (301, 302, 303) and '/plugins/servlet/rest-api-browser' in h_leg.get('location', ''),
          (s_leg, h_leg.get('location')))
    s, page, h = j.call('GET', NEXT + '?os_authType=basic', headers={'Accept': 'text/html'})
    if s in (301, 302, 303) and '/pulp/' in h.get('location', ''):
        s, page, h = j.call('GET', NEXT + '?os_authType=basic', headers={'Accept': 'text/html'})
    check('GET %s as %s answers 200 text/html' % (NEXT, a.user),
          s == 200 and 'text/html' in h.get('content-type', ''), (s, h.get('content-type'), h.get('location')))
    check('the new page has id="rab-next" and data-base-url', 'id="rab-next"' in page and 'data-base-url' in page,
          page[:300])
    assets = sorted(set(html.unescape(u) for u in re.findall(r'(?:src|href)="([^"]*:next-assets[^"]*)"', page)))
    # dev mode serves next.js and next.css one by one; outside dev mode the product batches them (next-assets.js/.css)
    check('the new page loads the web resource next-assets (its script and its stylesheet)',
          any(re.search(r'next(-assets)?\.js', u) for u in assets) and any(re.search(r'next(-assets)?\.css', u) for u in assets),
          assets or page[:300])
    bad = []
    for u in assets:
        s, body, _ = j.call('GET', urllib.parse.urljoin(j.url + '/', u), auth=False)
        if s != 200 or not body.strip():
            bad.append('%s -> %s' % (u, s))
    if assets:
        check('the %d next-assets URLs answer 200 with content' % len(assets), not bad, bad)
    s, _, h = j.call('GET', NEXT, auth=False, headers={'Accept': 'text/html'})
    loc = h.get('location', '')
    check('anonymous GET %s is sent to the login page' % NEXT,
          s in (301, 302, 303) and 'login' in loc.lower() and 'rest-api-browser' in urllib.parse.unquote(loc), (s, loc))

    # ---- the summary
    s, summary, h = j.json(API)
    etag = h.get('etag', '')
    check('GET %s as %s: 200 JSON with format 1, hash, product and modules' % (API, a.user),
          s == 200 and isinstance(summary, dict) and summary.get('format') == 1 and summary.get('hash')
          and summary.get('product') and isinstance(summary.get('modules'), list), (s, str(summary)[:200]))
    if not isinstance(summary, dict):
        return
    # admins' ETags end in -a, system administrators' in -s (they may also rebuild the catalog)
    check('the summary has an admin ETag (ending in -a" or -s") and Cache-Control no-cache',
          (etag.endswith('-a"') or etag.endswith('-s"')) and 'no-cache' in h.get('cache-control', ''),
          (etag, h.get('cache-control')))
    s, _, h2 = j.call('GET', API, headers={'Accept': 'application/json', 'If-None-Match': etag})
    check('a second GET with If-None-Match answers 304', s == 304, (s, h2.get('etag')))
    s, _, h = j.call('GET', API, auth=False, headers={'Accept': 'application/json'})
    check('anonymous GET %s is refused (401 or a redirect to the login page)' % API,
          s == 401 or (s in (301, 302, 303) and 'login' in h.get('location', '').lower()), (s, h.get('location')))
    print('Anonymous catalog request: %s' % ('401' if s == 401 else 'redirect %s to %s' % (s, h.get('location'))))

    # ---- complete
    t0 = time.time()
    summary, h = wait_complete(j)
    if summary and any(m.get('state') != 'ok' and m.get('reason') == 'not-started' for m in summary.get('modules', [])):
        j.call('POST', API + '/refresh', headers={'Accept': 'application/json', 'X-Atlassian-Token': 'no-check'})
        summary, h = wait_complete(j)
    if not check('the catalog becomes complete', summary, 'not complete after 120 s'):
        return
    print('The catalog was complete after %.0f s' % (time.time() - t0))
    mods = summary['modules']
    okm = [m for m in mods if m.get('state') == 'ok']
    for m in mods:
        if m.get('state') != 'ok':
            warn('catalog module failed: %s (%s): %s %s' % (m.get('id'), m.get('path'), m.get('reason'), m.get('error', '')))
    print('The catalog has %d modules, %d ok, %d operations, hash %s'
          % (len(mods), len(okm), sum(m.get('opCount', 0) for m in okm), summary['hash']))
    check('at least 95%% of the catalog\'s modules are ok (%d of %d)' % (len(okm), len(mods)),
          mods and len(okm) >= 0.95 * len(mods), [m.get('id') for m in mods if m.get('state') != 'ok'][:10])
    core_path = P['core'].replace('/rest/', '', 1).strip('/')
    core = [m for m in okm if m.get('path') == core_path]
    check('%s\'s core module (%s) is ok, supported, with at least 50 operations' % (P['name'], core_path),
          core and core[0].get('stability') == 'supported' and core[0].get('opCount', 0) >= 50,
          core[0] if core else [m.get('path') for m in mods][:10])

    # ---- the index
    hash_ = summary['hash']
    s, idx, h = j.json('%s/index/%s' % (API, hash_))
    cc = h.get('cache-control', '')
    check('GET %s/index/{hash}: 200, Cache-Control immutable and private' % API,
          s == 200 and 'immutable' in cc and 'private' in cc, (s, cc))
    ops = idx.get('operations') if isinstance(idx, dict) else None
    ids = set(m['id'] for m in mods)
    check('the index has the same hash and operations of known modules',
          ops and idx.get('hash') == hash_ and all(o.get('module') in ids for o in ops),
          (idx.get('hash') if isinstance(idx, dict) else None, len(ops or [])))
    s, body, h = j.call('GET', '%s/index/%s' % (API, 'f' * 24), headers={'Accept': 'application/json'})
    check('GET the index with a wrong hash: 404 and Cache-Control no-store',
          s == 404 and 'no-store' in h.get('cache-control', ''), (s, h.get('cache-control')))

    # ---- against the WADLs
    by_module = {}
    for o in ops or []:
        by_module.setdefault(o['module'], set()).add((o['method'].upper(), norm_path(o['path'])))
    comparable, agree, wadl_total, cat_total = 0, 0, 0, 0
    for m in okm:
        s, body, _ = j.call('GET', '/rest/%s/application.wadl' % m['path'].strip('/'),
                            headers={'Accept': 'application/xml'})
        if s != 200 or not is_wadl(body):
            continue
        try:
            want = wadl_operations(body)
        except ET.ParseError:
            continue
        have = by_module.get(m['id'], set())
        comparable += 1
        wadl_total += len(want)
        cat_total += len(have)
        if want == have:
            agree += 1
        else:
            only_w, only_c = sorted(want - have), sorted(have - want)
            warn('catalog differs from the WADL in %s (%s): %d only in the WADL %s, %d only in the catalog %s'
                 % (m['id'], m['path'], len(only_w), only_w[:3], len(only_c), only_c[:3]))
    print('WADL methods %d, catalog operations %d, in %d modules whose WADL loads' % (wadl_total, cat_total, comparable))
    check('the catalog agrees with the WADLs in at least 95%% of the comparable modules (%d of %d)' % (agree, comparable),
          comparable and agree >= 0.95 * comparable, '')

    # ---- refresh
    s, body, _ = j.call('POST', API + '/refresh', headers={'Accept': 'application/json'})
    check('POST %s/refresh without X-Atlassian-Token answers 403' % API, s == 403, (s, body[:100]))
    s, body, _ = j.call('POST', API + '/refresh', headers={'Accept': 'application/json', 'X-Atlassian-Token': 'no-check'})
    check('POST %s/refresh with X-Atlassian-Token: no-check answers 204' % API, s == 204, (s, body[:100]))
    if s == 204:
        summary2, _ = wait_complete(j)
        check('the catalog is complete again after the refresh', summary2 and
              len([m for m in summary2['modules'] if m.get('state') == 'ok']) == len(okm),
              summary2 and summary2.get('progress'))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--product', choices=sorted(PRODUCTS), default=os.environ.get('RAB_PRODUCT', 'jira'))
    ap.add_argument('--url', default=os.environ.get('RAB_URL'), help='default: the product.sh instance of the product')
    ap.add_argument('--user', default=os.environ.get('RAB_USER', 'admin'))
    ap.add_argument('--password', default=os.environ.get('RAB_PASSWORD', 'admin'))
    ap.add_argument('--jar', help='plugin jar to install (default: the newest target/rest-api-browser-*.jar)')
    ap.add_argument('--no-install', action='store_true', help='check the installed plugin, do not upload a jar')
    ap.add_argument('--uninstall', action='store_true', help='uninstall the plugin at the end')
    ap.add_argument('--expect-version', help='fail unless the product reports this version (e.g. 11.3.13)')
    ap.add_argument('--expect-bundle', action='store_true',
                    help='fail unless the page loads the bundle rest-api-browser.min.js (outside dev mode)')
    ap.add_argument('--log', help='atlassian-jira.log (confluence-LATEST.log) to scan for the plugin\'s errors '
                                  '(default: the product.sh one)')
    ap.add_argument('--allow-remote', action='store_true', help='allow a host other than localhost')
    a = ap.parse_args()
    P = PRODUCTS[a.product]
    a.url = a.url or P['url']

    host = urllib.parse.urlparse(a.url).hostname
    if host not in ('localhost', '127.0.0.1', '::1') and not a.allow_remote:
        print('smoke.py: %s is not localhost; this check installs and removes plugins (--allow-remote)' % host)
        return 2
    jar = None
    if not a.no_install:
        jar = a.jar or default_jar()
        if not jar or not os.path.isfile(jar):
            print('smoke.py: no plugin jar (build it with: mvn package -DskipTests, or pass --jar)')
            return 2
    j = Instance(a.url, a.user, a.password)

    # ---- the product itself: the application links manifest, anonymous in Jira and Confluence
    try:
        s, info, _ = j.json('/rest/applinks/1.0/manifest', auth=False)
    except OSError as e:
        print('smoke.py: %s does not answer: %s (start it with %ssrc/test/product/product.sh start)'
              % (a.url, e, '' if a.product == 'jira' else 'RAB_PRODUCT=%s ' % a.product))
        return 2
    if s != 200 or not info:
        print('smoke.py: %s/rest/applinks/1.0/manifest answered %s' % (a.url, s))
        return 2
    version = info.get('version')
    print('%s %s (build %s) at %s' % (P['name'], version, info.get('buildNumber'), a.url))
    if info.get('typeId') != a.product:
        print('smoke.py: %s is %s, not %s (--product)' % (a.url, info.get('typeId'), a.product))
        return 2
    s, _, _ = j.json(P['myself'])
    if s != 200:
        print('smoke.py: %s cannot log in as %s (%s)' % (a.url, a.user, s))
        return 2
    if a.expect_version:
        check('%s is version %s' % (P['name'], a.expect_version), version == a.expect_version, version)
    # the page builds every WADL URL from the base URL; AMPS's test data has the SDK's default port whatever the port
    # (product.sh start/wait fixes it)
    hint = ('; set it with: curl -u admin:admin -X PUT -H "Content-Type: application/json" -H "X-Atlassian-Token: '
            'no-check" --data %s %s/rest/api/2/settings/baseUrl (the raw URL, not a JSON string)' % (j.url, j.url)
            if a.product == 'jira' else '')
    check('%s\'s base URL is the URL under test' % P['name'], (info.get('url') or '').rstrip('/') == j.url,
          '%s; product.sh start/wait sets it%s' % (info.get('url'), hint))

    log = a.log or product_log_path(j, version, a.product)
    log_start = os.path.getsize(log) if log else 0

    # ---- install
    before = plugin_info(j)
    print('Installed before the run: %s' % ('%s %s (%s)' % (before.get('name'), before.get('version'),
                                                            'enabled' if before.get('enabled') else 'disabled')
                                            if before else 'none'))
    if jar:
        print('Jar: %s (version %s)' % (os.path.relpath(jar), jar_version(jar)))
        if not install(j, jar):
            return finish()
    info = plugin_info(j)
    if not check('plugin is installed and enabled', info and info.get('enabled'), info and info.get('version')):
        return finish()

    # ---- every module enabled (a module whose class or OSGi import fails on this product ends up disabled)
    modules = info.get('modules') or []
    disabled = ['%s (%s)' % (m.get('key'), m.get('name')) for m in modules if not m.get('enabled')]
    check('all %d modules are enabled' % len(modules), modules and not disabled, disabled)

    # ---- the page as admin
    s, page, h = j.call('GET', SERVLET + '?os_authType=basic', headers={'Accept': 'text/html'})
    if s in (301, 302, 303) and '/pulp/' in h.get('location', ''):
        # outside dev mode Confluence sends an admin to its post-upgrade landing page once after a start
        print('%s sent %s to its post-upgrade landing page (%s) once: asking again' % (P['name'], a.user, h['location']))
        s, page, h = j.call('GET', SERVLET + '?os_authType=basic', headers={'Accept': 'text/html'})
    check('GET %s as %s answers 200 text/html' % (SERVLET, a.user),
          s == 200 and 'text/html' in h.get('content-type', ''), (s, h.get('content-type'), h.get('location')))
    check('the page has the search field and the "public only" checkbox',
          'id="searchField"' in page and 'id="publicOnlyFilter"' in page, page[:300])
    check('the page links to the new UI in a new tab (button "Try the new UI")',
          'id="rab-new-ui-link"' in page and '/plugins/servlet/rest-api-browser' in page
          and bool(re.search(r'id="rab-new-ui-link"[^>]*target="_blank"', page)), page[:300])
    s_llms, llms_body, h_llms = j.call('GET', '/plugins/servlet/rest-api-browser/llms.txt?os_authType=basic',
                                       headers={'Accept': 'text/plain'})
    check('GET /plugins/servlet/rest-api-browser/llms.txt answers 200 llmstxt.org guide',
          s_llms == 200 and llms_body.startswith('# REST API Browser') and '/rest/restbrowser/1/code/graph' in llms_body,
          (s_llms, h_llms.get('content-type'), llms_body[:200]))
    check('the page is decorated by %s (header and the plugin\'s web resources)' % P['name'],
          'rest-api-browser' in page and re.search(r'download/(batch|resources|contextbatch)', page), page[:300])
    cfg = {}
    m_cfg_tag = re.search(r'<[^>]*\bid=["\']rab-config["\'][^>]*>', page)
    if m_cfg_tag:
        tag = m_cfg_tag.group(0)
        m_b64 = re.search(r'\bdata-config-b64=["\']([A-Za-z0-9+/=]+)["\']', tag)
        if m_b64:
            try:
                cfg = json.loads(base64.b64decode(m_b64.group(1)).decode('utf-8'))
            except ValueError:
                cfg = {}
        if not cfg:
            m_cfg = re.search(r'\bdata-config=["\']([^"\']*)["\']', tag)
            if m_cfg:
                try:
                    cfg = json.loads(html.unescape(m_cfg.group(1)))
                except ValueError:
                    cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    prod = cfg.get('product') or (lambda m: m and m.group(1))(re.search(r'RAB\.product = "([^"]*)"', page))
    check('the page names the product as %s' % P['name'], prod and re.search(a.product, prod, re.I), prod)
    services = [s['wadl'] for s in cfg.get('services', ()) if isinstance(s, dict) and s.get('wadl')]
    if not services:
        services = [html.unescape(w) for w in re.findall(r'"wadl":"([^"]+)"', page)]
    print('The page lists %d REST modules' % len(services))
    check('the page lists the REST modules of %s (at least 20)' % P['name'], len(services) >= 20, len(services))
    core_wadl = P['core'] + '/application.wadl'
    core = [w for w in services if w.endswith(core_wadl)]
    check('the list has %s\'s core REST API (%s)' % (P['name'], P['core']), core, services[:10])

    # ---- the WADLs the page loads in the browser: the sidebar is built from them. The page itself leaves out Crowd's
    # usermanagement and appmanagement modules (rest_resources_service.js: they need application credentials)
    loaded = [w for w in services if not re.search(r'usermanagement|appmanagement', w)]
    bad, no_txw2 = [], 0
    for w in loaded:
        s, body, h = j.call('GET', w, headers={'Accept': 'application/xml'}, timeout=60)
        if s != 200 or not is_wadl(body):
            bad.append('%s -> %s' % (w.replace(j.url, ''), s))
            no_txw2 += 'com/sun/xml/txw2/' in body
    ok = len(loaded) - len(bad)
    print('WADLs served: %d of the %d the page loads (%d left out like the page does)'
          % (ok, len(loaded), len(services) - len(loaded)))
    for b in bad:
        warn('WADL not served: ' + b)
    if no_txw2:
        print('  %d of them fail in %s itself: JAXB\'s schema writer txw2 is missing from its WEB-INF/lib (Confluence '
              '10.2.20 does not ship it; see src/test/product/README.md)' % (no_txw2, P['name']))
    check('%s serves the WADL of %s (the sidebar\'s public APIs)' % (P['name'], P['core']),
          core and not any(b.startswith(core_wadl + ' ') for b in bad), [b for b in bad if b.startswith(core_wadl + ' ')])
    check('%s serves at least 95%% of the WADLs the page loads (%d of %d)' % (P['name'], ok, len(loaded)),
          loaded and ok >= 0.95 * len(loaded), bad[:10])

    # ---- the web resources of the page
    res = sorted(set(html.unescape(u) for u in re.findall(r'(?:src|href)="([^"]*com\.atlassian\.labs\.rest-api-browser[^"]*)"', page)))
    res_bad = []
    for u in res:
        full = u if u.startswith('http') else urllib.parse.urljoin(j.url + '/', u)
        s, body, _ = j.call('GET', full, auth=False)
        if s != 200 or not body.strip():
            res_bad.append('%s -> %s' % (u, s))
    if res:
        check('the plugin\'s %d web resource URLs on the page answer 200 with content' % len(res), not res_bad, res_bad)
    else:
        skip('the plugin\'s web resources', 'the page has no URL naming the plugin (batched with others)')
    # outside dev mode the page loads the bundle rest-api-browser.min.js (web resource assets-production), in dev mode
    # the scripts one by one (assets-devmode)
    bundle = any(':assets-production' in u for u in res)
    print('The page loads its scripts %s' % ('as the bundle rest-api-browser.min.js' if bundle else
          'one by one (dev mode)' if any(':assets-devmode' in u for u in res) else 'from no URL naming the plugin'))
    if a.expect_bundle:
        check('the page loads the bundle rest-api-browser.min.js (outside dev mode)', bundle, res)
    s, body, _ = j.call('GET', '/download/resources/%s:assets-production/rest-api-browser.min.js' % PLUGIN_KEY, auth=False)
    check('the production JavaScript bundle is served', s == 200 and 'RAB' in body, s)
    # the Angular routes load their views from the plugin's "rab/" download resource (app.js, resourcePrefix)
    for view in ('main.html', 'resource.html'):
        s, body, _ = j.call('GET', '/download/resources/%s:assets/rab/views/%s' % (PLUGIN_KEY, view), auth=False)
        want = bundled_file(jar, 'assets/rab/views/' + view)
        check('the Angular view %s is served (as in the jar)' % view,
              s == 200 and body.strip() and (want is None or body.replace('\r\n', '\n').strip() == want.replace('\r\n', '\n').strip()),
              (s, body[:120]))

    # ---- the pretty URL (routing module, atlassian-pretty-urls-plugin)
    s, body, h = j.call('GET', '/restbrowser?os_authType=basic', headers={'Accept': 'text/html'})
    check('GET /restbrowser (pretty URL) shows the page', s == 200 and 'id="publicOnlyFilter"' in body,
          (s, h.get('location')))

    # ---- anonymous: the standalone instance does not set -Drest.api.browser.anonymous=true
    s, body, h = j.call('GET', SERVLET, auth=False, headers={'Accept': 'text/html'})
    loc = h.get('location', '')
    check('anonymous GET %s is sent to the login page' % SERVLET,
          s in (301, 302, 303) and 'login' in loc.lower() and 'restbrowser' in urllib.parse.unquote(loc), (s, loc))

    # ---- admin intro entry page (/plugins/servlet/rest-api-browser/admin)
    s_adm, adm_page, h_adm = j.call('GET', '/plugins/servlet/rest-api-browser/admin?os_authType=basic',
                                    headers={'Accept': 'text/html'})
    check('GET /plugins/servlet/rest-api-browser/admin as %s answers 200 text/html' % a.user,
          s_adm == 200 and 'text/html' in h_adm.get('content-type', ''),
          (s_adm, h_adm.get('content-type'), h_adm.get('location')))
    check('the admin intro page renders launch CTA, agent links, and debug prompt',
          'id="rab-admin-intro"' in adm_page
          and 'id="rab-open-fullscreen"' in adm_page
          and '/plugins/servlet/rest-api-browser"' in adm_page
          and 'llms.txt' in adm_page and 'llms-full.txt' in adm_page
          and 'openapi.json' in adm_page and '/rest/restbrowser/1/mcp' in adm_page
          and 'id="rab-prompt-stuck"' in adm_page,
          adm_page[:300])
    s_adm_an, _, h_adm_an = j.call('GET', '/plugins/servlet/rest-api-browser/admin',
                                   auth=False, headers={'Accept': 'text/html'})
    loc_adm = h_adm_an.get('location', '')
    check('anonymous GET /plugins/servlet/rest-api-browser/admin is sent to login',
          s_adm_an in (301, 302, 303) and 'login' in loc_adm.lower(), (s_adm_an, loc_adm))

    # ---- the new UI and its catalog API
    new_ui(j, a, P)

    # ---- the product's log: no error of the plugin since the install
    if log:
        with open(log, 'rb') as f:
            f.seek(log_start)
            new = f.read().decode('utf-8', 'replace')
        lines = new.splitlines()
        err_at = [i for i, ln in enumerate(lines)
                  if re.search(r'\b(ERROR|FATAL)\b', ln) and re.search(r'restbrowser|rest-api-browser|labs\.restbrowser', ln)]
        # Confluence 10 refuses the anonymous request above itself (the site has no anonymous access, and the servlet
        # is @AnonymousSiteAccess) and logs that as an ERROR with an AuthorisationException: not the plugin's error
        refused = [i for i in err_at if any('AuthorisationException' in ln for ln in lines[i + 1:i + 4])]
        for i in refused:
            warn('%s logs its refusal of the anonymous request as an ERROR: %s' % (P['name'], lines[i][:120]))
        errs = [lines[i] for i in err_at if i not in refused]
        traces = len(re.findall(r'at com\.atlassian\.labs\.restbrowser\.', new))
        print('%s log: %s (%d new lines)' % (P['name'], log, len(lines)))
        check('no ERROR line naming the plugin in %s\'s log since the run started' % P['name'], not errs, errs[:5])
        check('no stack trace through the plugin\'s classes in %s\'s log' % P['name'], traces == 0,
              '%d frames' % traces)
    else:
        skip('%s log' % P['name'], '%s not found (pass --log)' % P['log'][-1])

    if a.uninstall:
        uninstall(j)
        if before and jar:
            warn('the plugin was installed before the run (%s); it is gone now' % before.get('version'))
    return finish()


def finish():
    failed = [n for n, ok in results if not ok]
    line = '%d checks, %d passed, %d failed' % (len(results), len(results) - len(failed), len(failed))
    if skipped:
        line += ', %d skipped' % len(skipped)
    if warnings:
        line += ', %d warnings' % len(warnings)
    print(line)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
