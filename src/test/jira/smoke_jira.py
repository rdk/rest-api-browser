#!/usr/bin/env python3
"""Real-Jira smoke check of the REST API Browser (RAB): installs the plugin jar through UPM and checks it over HTTP.

    python src/test/jira/smoke_jira.py --expect-jira 11.3.13            # newest target/rest-api-browser-*.jar
    python src/test/jira/smoke_jira.py --jar target/rest-api-browser-4.0.0-SNAPSHOT.jar
    python src/test/jira/smoke_jira.py --no-install                     # check what is installed
    python src/test/jira/smoke_jira.py --uninstall                      # remove the plugin at the end

Settings: JIRA_URL (default http://localhost:2992/jira, the Jira of src/test/jira/jira.sh) or --url, JIRA_USER /
JIRA_PASSWORD (default admin/admin) or --user / --password. It installs a plugin, so it refuses a host other than
localhost unless --allow-remote. Python 3.9+, standard library only.

Exit code: 0 all checks passed (WARN and SKIP lines do not count), 1 a check failed, 2 not run (Jira not reachable,
not authorized, no jar). The last line is "N checks, N passed, N failed".
"""
import argparse
import base64
import glob
import html
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

PLUGIN_KEY = 'com.atlassian.labs.rest-api-browser'
SERVLET = '/plugins/servlet/restbrowser'
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))

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


class Jira:
    def __init__(self, url, user, password):
        self.url = url.rstrip('/')
        self.auth = 'Basic ' + base64.b64encode(('%s:%s' % (user, password)).encode()).decode()
        self.opener = urllib.request.build_opener(NoRedirect)

    def call(self, method, path, body=None, headers=None, auth=True, timeout=60):
        """(status, body text, headers dict with lower-case keys); never raises for an HTTP status."""
        url = path if path.startswith('http') else self.url + path
        h = {'Accept': '*/*'}
        if auth:
            h['Authorization'] = self.auth
        h.update(headers or {})
        req = urllib.request.Request(url, data=body, headers=h, method=method)
        try:
            with self.opener.open(req, timeout=timeout) as r:
                return r.status, r.read().decode('utf-8', 'replace'), {k.lower(): v for k, v in r.headers.items()}
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode('utf-8', 'replace'), {k.lower(): v for k, v in e.headers.items()}
        except (urllib.error.URLError, OSError) as e:
            if not url.startswith(self.url):
                return 0, str(e), {}  # another host (a URL on the page): a failed check, not a crash
            raise

    def json(self, path, accept='application/json', **kw):
        import json
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
        return False
    want = jar_version(jar)
    info, same_other = None, 0
    for _ in range(150):  # enabling a freshly uploaded plugin can take a few minutes on a cold Jira
        time.sleep(2)
        info = plugin_info(j)
        if info and info.get('enabled') and (want is None or info.get('version') == want):
            return check('plugin %s is installed and enabled' % (want or ''), True)
        # Jira keeps the higher version of a plugin key and drops a lower upload while UPM reports success
        same_other = same_other + 1 if info and info.get('enabled') else 0
        if same_other >= 30:
            break
    got = info.get('version') if info else None
    if want and got and got != want:
        return check('plugin %s is installed and enabled' % want, False,
                     'Jira runs version %s, not the jar\'s %s: Jira keeps the higher version of a plugin key, '
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


def jira_log_path(j, version):
    """atlassian-jira.log of the jira.sh Jira, when it is on this machine."""
    port = urllib.parse.urlparse(j.url).port or 80
    workdir = os.environ.get('JIRA_WORKDIR') or os.path.join(os.path.expanduser('~'), 'jira-rab-%s-%s' % (version, port))
    p = os.path.join(workdir, 'amps-standalone-jira-%s' % version, 'target', 'jira', 'home', 'log', 'atlassian-jira.log')
    return p if os.path.isfile(p) else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--url', default=os.environ.get('JIRA_URL', 'http://localhost:2992/jira'))
    ap.add_argument('--user', default=os.environ.get('JIRA_USER', 'admin'))
    ap.add_argument('--password', default=os.environ.get('JIRA_PASSWORD', 'admin'))
    ap.add_argument('--jar', help='plugin jar to install (default: the newest target/rest-api-browser-*.jar)')
    ap.add_argument('--no-install', action='store_true', help='check the installed plugin, do not upload a jar')
    ap.add_argument('--uninstall', action='store_true', help='uninstall the plugin at the end')
    ap.add_argument('--expect-jira', help='fail unless Jira reports this version (e.g. 11.3.13)')
    ap.add_argument('--jira-log', help='atlassian-jira.log to scan for the plugin\'s errors (default: the jira.sh one)')
    ap.add_argument('--allow-remote', action='store_true', help='allow a host other than localhost')
    a = ap.parse_args()

    host = urllib.parse.urlparse(a.url).hostname
    if host not in ('localhost', '127.0.0.1', '::1') and not a.allow_remote:
        print('smoke_jira.py: %s is not localhost; this check installs and removes plugins (--allow-remote)' % host)
        return 2
    jar = None
    if not a.no_install:
        jar = a.jar or default_jar()
        if not jar or not os.path.isfile(jar):
            print('smoke_jira.py: no plugin jar (build it with: mvn package -DskipTests, or pass --jar)')
            return 2
    j = Jira(a.url, a.user, a.password)

    # ---- Jira itself
    try:
        s, info, _ = j.json('/rest/api/2/serverInfo')
    except OSError as e:
        print('smoke_jira.py: %s does not answer: %s (start it with src/test/jira/jira.sh start)' % (a.url, e))
        return 2
    if s != 200 or not info:
        print('smoke_jira.py: %s/rest/api/2/serverInfo answered %s' % (a.url, s))
        return 2
    version = info.get('version')
    print('Jira %s (build %s, %s) at %s' % (version, info.get('buildNumber'), info.get('deploymentType'), a.url))
    s, _, _ = j.json('/rest/api/2/myself')
    if s != 200:
        print('smoke_jira.py: %s cannot log in as %s (%s)' % (a.url, a.user, s))
        return 2
    if a.expect_jira:
        check('Jira is version %s' % a.expect_jira, version == a.expect_jira, version)
    # the page builds every WADL URL from the base URL; AMPS's test data has :2990 whatever the port (jira.sh fixes it)
    check('Jira\'s base URL is the URL under test', (info.get('baseUrl') or '').rstrip('/') == j.url,
          '%s; set it with: curl -u admin:admin -X PUT -H "Content-Type: application/json" -H "X-Atlassian-Token: '
          'no-check" --data %s %s/rest/api/2/settings/baseUrl (the raw URL, not a JSON string; jira.sh start/wait does it)'
          % (info.get('baseUrl'), j.url, j.url))

    log = a.jira_log or jira_log_path(j, version)
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

    # ---- every module enabled (a module whose class or OSGi import fails on this Jira ends up disabled)
    modules = info.get('modules') or []
    disabled = ['%s (%s)' % (m.get('key'), m.get('name')) for m in modules if not m.get('enabled')]
    check('all %d modules are enabled' % len(modules), modules and not disabled, disabled)

    # ---- the page as admin
    s, page, h = j.call('GET', SERVLET + '?os_authType=basic', headers={'Accept': 'text/html'})
    check('GET %s as %s answers 200 text/html' % (SERVLET, a.user),
          s == 200 and 'text/html' in h.get('content-type', ''), (s, h.get('content-type'), h.get('location')))
    check('the page has the search field and the "public only" checkbox',
          'id="searchField"' in page and 'id="publicOnlyFilter"' in page, page[:300])
    check('the page is decorated by Jira (header and the plugin\'s web resources)',
          'rest-api-browser' in page and re.search(r'download/(batch|resources|contextbatch)', page), page[:300])
    m = re.search(r'RAB\.product = "([^"]*)"', page)
    check('the page names the product as Jira', m and re.search('jira', m.group(1), re.I), m and m.group(1))
    services = [html.unescape(w) for w in re.findall(r'"wadl":"([^"]+)"', page)]
    jsonrpcs = re.search(r'RAB\.rest\.jsonRpcs = \[\s*\];', page)
    print('The page lists %d REST modules' % len(services))
    check('the page lists the REST modules of Jira (at least 20)', len(services) >= 20, len(services))
    core = [w for w in services if re.search(r'/rest/api/2/application\.wadl$', w)]
    check('the list has Jira\'s core REST API (/rest/api/2)', core, services[:10])
    check('the list has the plugin\'s own REST module (/rest/devtools/1)',
          any(w.endswith('/rest/devtools/1/application.wadl') for w in services), services[:10])
    check('the JSON-RPC list is empty on Jira (JiraBeans has no SOAP services)', jsonrpcs)

    # ---- the WADLs the page loads in the browser: the sidebar is built from them. The page itself leaves out Crowd's
    # usermanagement and appmanagement modules (rest_resources_service.js: they need application credentials)
    loaded = [w for w in services if not re.search(r'usermanagement|appmanagement', w)]
    bad = []
    for w in loaded:
        s, body, h = j.call('GET', w, headers={'Accept': 'application/xml'}, timeout=60)
        if s != 200 or not is_wadl(body):
            bad.append('%s -> %s' % (w.replace(j.url, ''), s))
    ok = len(loaded) - len(bad)
    print('WADLs served: %d of the %d the page loads (%d left out like the page does)'
          % (ok, len(loaded), len(services) - len(loaded)))
    for b in bad:
        warn('WADL not served: ' + b)
    check('Jira serves the WADL of /rest/api/2 (the sidebar\'s public APIs)',
          core and not any('/rest/api/2/application.wadl ' in b + ' ' for b in bad), bad[:5])
    check('Jira serves at least 95%% of the WADLs the page loads (%d of %d)' % (ok, len(loaded)),
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
    s, body, _ = j.call('GET', '/download/resources/%s:assets-production/rest-api-browser.min.js' % PLUGIN_KEY, auth=False)
    check('the production JavaScript bundle is served', s == 200 and 'RAB' in body, s)
    # the Angular routes load their views from the plugin's "rab/" download resource (app.js, resourcePrefix)
    for view in ('main.html', 'resource.html'):
        s, body, _ = j.call('GET', '/download/resources/%s:assets/rab/views/%s' % (PLUGIN_KEY, view), auth=False)
        want = bundled_file(jar, 'assets/rab/views/' + view)
        check('the Angular view %s is served (as in the jar)' % view,
              s == 200 and body.strip() and (want is None or body.replace('\r\n', '\n').strip() == want.replace('\r\n', '\n').strip()),
              (s, body[:120]))

    # ---- the plugin's REST resources (REST v2, jakarta.ws.rs)
    s, body, h = j.call('GET', '/rest/devtools/1/ewadl', headers={'Accept': 'application/xml'})
    check('GET /rest/devtools/1/ewadl answers 200 WADL', s == 200 and is_wadl(body),
          (s, h.get('content-type'), body[:200]))
    s, body, _ = j.call('GET', '/rest/devtools/1/jsonrpc/%s/wadl' % PLUGIN_KEY, headers={'Accept': 'application/xml'})
    check('GET /rest/devtools/1/jsonrpc/{an enabled plugin}/wadl answers 200 WADL', s == 200 and is_wadl(body),
          (s, body[:200]))
    s, body, _ = j.call('GET', '/rest/devtools/1/jsonrpc/no.such.plugin/wadl', headers={'Accept': 'application/xml'})
    check('GET /rest/devtools/1/jsonrpc/{unknown plugin}/wadl answers 404', s == 404, s)

    # ---- the pretty URL (routing module, atlassian-pretty-urls-plugin)
    s, body, h = j.call('GET', '/restbrowser?os_authType=basic', headers={'Accept': 'text/html'})
    check('GET /restbrowser (pretty URL) shows the page', s == 200 and 'id="publicOnlyFilter"' in body,
          (s, h.get('location')))

    # ---- anonymous: Jira's standalone instance does not set -Drest.api.browser.anonymous=true
    s, body, h = j.call('GET', SERVLET, auth=False, headers={'Accept': 'text/html'})
    loc = h.get('location', '')
    check('anonymous GET %s is sent to the login page' % SERVLET,
          s in (301, 302, 303) and 'login' in loc.lower() and 'restbrowser' in urllib.parse.unquote(loc), (s, loc))

    # ---- Jira's log: no error of the plugin since the install
    if log:
        with open(log, 'rb') as f:
            f.seek(log_start)
            new = f.read().decode('utf-8', 'replace')
        lines = new.splitlines()
        errs = [ln for i, ln in enumerate(lines)
                if re.search(r'\b(ERROR|FATAL)\b', ln) and re.search(r'restbrowser|rest-api-browser|labs\.restbrowser', ln)]
        traces = len(re.findall(r'at com\.atlassian\.labs\.restbrowser\.', new))
        print('Jira log: %s (%d new lines)' % (log, len(lines)))
        check('no ERROR line naming the plugin in Jira\'s log since the run started', not errs, errs[:5])
        check('no stack trace through the plugin\'s classes in Jira\'s log', traces == 0, '%d frames' % traces)
    else:
        skip('Jira log', 'atlassian-jira.log not found (pass --jira-log)')

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
