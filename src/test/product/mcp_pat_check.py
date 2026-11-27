#!/usr/bin/env python3
"""Verify REST API Browser's MCP endpoint over Bearer PAT authentication only.

Runs initialize, notifications/initialized, ping, tools/list, tools/call,
resources/list, resources/templates/list, resources/read, prompts/list, and
prompts/get against <url>/rest/restbrowser/1/mcp using ONLY
``Authorization: Bearer <PAT>`` (no cookies, no Basic Auth, no X-Atlassian-Token).

If --pat is omitted, creates a short-lived (1-day) Data Center PAT via
``POST /rest/pat/latest/tokens`` using --user / --password and revokes it in a
``finally`` block regardless of pass/failure.
"""

import argparse
import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def make_ssl_context(ca_file=None, insecure=False):
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    if ca_file:
        return ssl.create_default_context(cafile=ca_file)
    return None


def http_json(method, url, headers, body_obj=None, ctx=None, timeout=60):
    data = None if body_obj is None else json.dumps(body_obj).encode('utf-8')
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
            raw = resp.read().decode('utf-8', 'replace')
            return resp.status, json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            parsed = json.loads(raw) if raw.strip() else raw
        except ValueError:
            parsed = raw
        return e.code, parsed


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--url', default=os.environ.get('RAB_URL', 'http://localhost:2992/jira'))
    ap.add_argument('--pat', default=os.environ.get('RAB_PAT'))
    ap.add_argument('--user', default=os.environ.get('RAB_USER', 'admin'))
    ap.add_argument('--password', default=os.environ.get('RAB_PASSWORD', 'admin'))
    ap.add_argument('--ca-file', default=os.environ.get('RAB_CA_FILE') or os.environ.get('SSL_CERT_FILE'))
    ap.add_argument('--insecure', action='store_true', help='skip TLS certificate verification')
    ap.add_argument('--allow-remote', action='store_true', help='allow non-localhost URL')
    a = ap.parse_args()

    base = a.url.rstrip('/')
    host = urllib.parse.urlparse(base).hostname or ''
    if not a.allow_remote and host not in ('localhost', '127.0.0.1', '::1'):
        print('FAIL refuse non-localhost URL without --allow-remote', file=sys.stderr)
        return 2

    ctx = make_ssl_context(a.ca_file, a.insecure)
    mcp_url = base + '/rest/restbrowser/1/mcp'

    pat = a.pat
    temp_token_id = None
    basic_headers = None

    if not pat:
        cred = base64.b64encode(('%s:%s' % (a.user, a.password)).encode('utf-8')).decode('ascii')
        basic_headers = {
            'Authorization': 'Basic ' + cred,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Atlassian-Token': 'no-check',
        }
        tok_name = 'rab-mcp-check-%d' % int(time.time())
        status, created = http_json(
            'POST', base + '/rest/pat/latest/tokens',
            basic_headers, {'name': tok_name, 'expirationDuration': 1}, ctx=ctx,
        )
        if status not in (200, 201) or not isinstance(created, dict) or not created.get('rawToken'):
            print('FAIL could not create temporary PAT via /rest/pat/latest/tokens: HTTP %s' % status, file=sys.stderr)
            return 2
        pat = created['rawToken']
        temp_token_id = created.get('id')

    results = []

    def check(name, ok, detail=''):
        results.append((name, bool(ok)))
        print('%s %s%s' % ('PASS' if ok else 'FAIL', name, '' if ok or not detail else ' -- %s' % detail))
        return bool(ok)

    pat_headers = {
        'Authorization': 'Bearer ' + pat,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }

    def rpc(req_id, method, params=None):
        payload = {'jsonrpc': '2.0', 'method': method}
        if req_id is not None:
            payload['id'] = req_id
        if params is not None:
            payload['params'] = params
        return http_json('POST', mcp_url, pat_headers, payload, ctx=ctx)

    try:
        s, init = rpc(1, 'initialize')
        init_res = (init or {}).get('result', {}) if isinstance(init, dict) else {}
        caps = init_res.get('capabilities', {}) if isinstance(init_res, dict) else {}
        check('PAT initialize returns protocolVersion and tools/resources/prompts capabilities',
              s == 200 and init_res.get('protocolVersion') == '2025-03-26'
              and all(k in caps for k in ('tools', 'resources', 'prompts')), (s, caps))

        s_notif, _ = rpc(None, 'notifications/initialized')
        check('PAT notifications/initialized answers 202', s_notif == 202, s_notif)

        s_ping, ping = rpc(2, 'ping')
        check('PAT ping returns empty result object', s_ping == 200 and isinstance(ping, dict) and ping.get('result') == {}, s_ping)

        s_tl, tl = rpc(3, 'tools/list')
        tools = ((tl or {}).get('result') or {}).get('tools') if isinstance(tl, dict) else None
        check('PAT tools/list returns at least 4 tools', s_tl == 200 and isinstance(tools, list) and len(tools) >= 4,
              (s_tl, len(tools) if isinstance(tools, list) else tools))

        s_tc, tc = rpc(4, 'tools/call', {'name': 'search_operations', 'arguments': {'limit': 2}})
        tc_res = (tc or {}).get('result') or {} if isinstance(tc, dict) else {}
        check('PAT tools/call(search_operations) succeeds', s_tc == 200 and tc_res.get('isError') is False and bool(tc_res.get('content')),
              (s_tc, tc_res.get('isError')))

        s_rl, rl = rpc(5, 'resources/list')
        resources = ((rl or {}).get('result') or {}).get('resources') if isinstance(rl, dict) else None
        uris = {r.get('uri') for r in (resources or []) if isinstance(r, dict)}
        check('PAT resources/list includes llms.txt, catalog summary, and openapi/self',
              s_rl == 200 and {'rab://llms.txt', 'rab://llms-full.txt', 'rab://catalog/summary', 'rab://openapi/self'}.issubset(uris),
              (s_rl, sorted(uris)))

        s_rtl, rtl = rpc(6, 'resources/templates/list')
        tpls = ((rtl or {}).get('result') or {}).get('resourceTemplates') if isinstance(rtl, dict) else None
        check('PAT resources/templates/list returns module OpenAPI template',
              s_rtl == 200 and isinstance(tpls, list) and any(t.get('uriTemplate') == 'rab://catalog/openapi/{module}' for t in tpls),
              (s_rtl, tpls))

        first_mod = None
        for r_uri in ('rab://llms.txt', 'rab://catalog/summary', 'rab://openapi/self'):
            s_rr, rr = rpc(7, 'resources/read', {'uri': r_uri})
            contents = ((rr or {}).get('result') or {}).get('contents') if isinstance(rr, dict) else None
            txt = contents[0].get('text', '') if isinstance(contents, list) and contents else ''
            check('PAT resources/read(%s) returns non-empty text' % r_uri, s_rr == 200 and bool(txt.strip()), (s_rr, len(txt)))
            if r_uri == 'rab://catalog/summary' and txt.strip():
                try:
                    mods = json.loads(txt).get('modules') or []
                    ok_mod = next((m for m in mods if m.get('state') == 'ok'), None)
                    if ok_mod:
                        first_mod = ok_mod.get('id')
                except ValueError:
                    pass

        if first_mod:
            mod_uri = 'rab://catalog/openapi/' + urllib.parse.quote(first_mod, safe='')
            s_mr, mr = rpc(8, 'resources/read', {'uri': mod_uri})
            m_contents = ((mr or {}).get('result') or {}).get('contents') if isinstance(mr, dict) else None
            m_txt = m_contents[0].get('text', '') if isinstance(m_contents, list) and m_contents else ''
            check('PAT resources/read(module OpenAPI) returns OpenAPI 3.1 JSON',
                  s_mr == 200 and '"openapi": "3.1.0"' in m_txt or '"openapi":"3.1.0"' in m_txt, (s_mr, m_txt[:120]))

        s_pl, pl = rpc(9, 'prompts/list')
        prompts = ((pl or {}).get('result') or {}).get('prompts') if isinstance(pl, dict) else None
        p_names = {p.get('name') for p in (prompts or []) if isinstance(p, dict)}
        check('PAT prompts/list exposes explore-endpoint-payload',
              s_pl == 200 and 'explore-endpoint-payload' in p_names, (s_pl, sorted(p_names)))

        s_pg, pg = rpc(10, 'prompts/get', {'name': 'explore-endpoint-payload', 'arguments': {'query': 'serverInfo'}})
        msgs = ((pg or {}).get('result') or {}).get('messages') if isinstance(pg, dict) else None
        p_txt = ((msgs[0].get('content') or {}).get('text') or '') if isinstance(msgs, list) and msgs else ''
        check('PAT prompts/get(explore-endpoint-payload) interpolates query argument',
              s_pg == 200 and 'serverInfo' in p_txt, (s_pg, p_txt[:120]))
    finally:
        if temp_token_id is not None and basic_headers is not None:
            del_url = base + '/rest/pat/latest/tokens/' + urllib.parse.quote(str(temp_token_id), safe='')
            s_del, _ = http_json('DELETE', del_url, basic_headers, ctx=ctx)
            if s_del not in (200, 204, 404):
                print('WARN failed to revoke temporary PAT id=%s: HTTP %s' % (temp_token_id, s_del), file=sys.stderr)

    failed = [n for n, ok in results if not ok]
    print('%d checks, %d passed, %d failed' % (len(results), len(results) - len(failed), len(failed)))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
