import base64
import http.server
import io
import json
import os
import sys
import threading
import unittest
import urllib.parse
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rab  # noqa: E402


class RecordingHandler(http.server.BaseHTTPRequestHandler):
    requests = []
    next_response = None

    def log_message(self, format, *args):  # noqa: A002
        return

    def _handle(self, method: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        raw_body = self.rfile.read(length) if length > 0 else b""
        RecordingHandler.requests.append(
            {
                "method": method,
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": raw_body.decode("utf-8", "replace"),
            }
        )
        status, ctype, payload, extra = (
            RecordingHandler.next_response
            if RecordingHandler.next_response
            else (200, "application/json", '{"ok":true}', {})
        )
        RecordingHandler.next_response = None
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload.encode("utf-8"))

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")


class RabClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
        cls.port = cls.server.server_port
        cls.base_url = f"http://127.0.0.1:{cls.port}/jira"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        RecordingHandler.requests.clear()
        RecordingHandler.next_response = None

    def test_pat_auth_and_brief_with_node_header(self) -> None:
        RecordingHandler.next_response = (
            200,
            "text/plain;charset=utf-8",
            "REST API Browser Jira 11.3.13 | node=NODE-1 | liveScalpel=true\n",
            {"X-Node-Id": "NODE-1"},
        )
        client = rab.RabClient(self.base_url, token="pat-secret")
        out = client.brief(top=5)
        self.assertIn("node=NODE-1", out)
        self.assertEqual(client.last_node, "NODE-1")
        req = RecordingHandler.requests[0]
        self.assertEqual(req["path"], "/jira/rest/restbrowser/1/catalog/brief?top=5")
        self.assertEqual(req["headers"]["authorization"], "Bearer pat-secret")

    def test_basic_auth_post_xsrf_and_sticky_cookie(self) -> None:
        RecordingHandler.next_response = (
            200,
            "text/markdown;charset=utf-8",
            "# Context\n",
            {"Set-Cookie": "JSESSIONID=sticky123; Path=/jira"},
        )
        client = rab.RabClient(self.base_url, user="admin", password="pw")
        res = client.context(op="jira:api2:GET:serverInfo", max_chars=2500)
        self.assertEqual(res, "# Context\n")
        req = RecordingHandler.requests[0]
        expected_basic = "Basic " + base64.b64encode(b"admin:pw").decode("ascii")
        self.assertEqual(req["headers"]["authorization"], expected_basic)
        self.assertEqual(req["headers"]["x-atlassian-token"], "no-check")
        body = json.loads(req["body"])
        self.assertEqual(body["op"], "jira:api2:GET:serverInfo")
        self.assertEqual(body["maxChars"], 2500)
        self.assertEqual(body["format"], "markdown")

        # Follow-up request reuses sticky JSESSIONID cookie
        RecordingHandler.next_response = (200, "application/json", '{"headers":[]}', {})
        client.echo()
        self.assertIn("JSESSIONID=sticky123", RecordingHandler.requests[1]["headers"].get("cookie", ""))

    def test_error_parsing_raises_rab_error(self) -> None:
        RecordingHandler.next_response = (
            403,
            "application/json",
            '{"error":"system-admin-only","hint":"Use a sysadmin PAT"}',
            {},
        )
        client = rab.RabClient(self.base_url, token="t")
        with self.assertRaises(rab.RabError) as ctx:
            client.source(class_name="com.example.Foo")
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.code, "system-admin-only")
        self.assertIn("sysadmin PAT", str(ctx.exception))

    def test_rejects_mixed_credentials_and_empty_url(self) -> None:
        with self.assertRaises(ValueError):
            rab.RabClient("", token="t")
        with self.assertRaises(ValueError):
            rab.RabClient(self.base_url, user="admin", token="t")

    def test_clip_output_respects_limit_and_unlimited(self) -> None:
        self.assertEqual(rab.clip_output("abc", 0), "abc")
        clipped = rab.clip_output("x" * 200, 50)
        self.assertIn("truncated 150 chars", clipped)

    def test_from_env_and_cli_dispatch_mcp_and_search(self) -> None:
        old = os.environ.copy()
        try:
            os.environ["RAB_URL"] = self.base_url
            os.environ["RAB_TOKEN"] = "env-token"
            RecordingHandler.next_response = (
                200,
                "text/markdown",
                "| op |\n|---|\n| jira:api2:GET:issue/{} |\n",
                {},
            )
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = rab.main(["--max-chars", "100", "search", "issue", "--method", "GET", "--limit", "5"])
            self.assertEqual(rc, 0)
            self.assertIn("jira:api2:GET:issue", buf.getvalue())
            parsed = urllib.parse.urlparse(RecordingHandler.requests[0]["path"])
            qs = urllib.parse.parse_qs(parsed.query)
            self.assertEqual(qs["q"], ["issue"])
            self.assertEqual(qs["method"], ["GET"])
            self.assertEqual(qs["limit"], ["5"])
            self.assertEqual(qs["format"], ["markdown"])

            RecordingHandler.next_response = (
                200,
                "application/json",
                '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
                {},
            )
            buf2 = io.StringIO()
            with redirect_stdout(buf2):
                rc2 = rab.main(["mcp", "tools/call", "--name", "get_catalog_summary", "--args", '{"format":"brief"}'])
            self.assertEqual(rc2, 0)
            sent = json.loads(RecordingHandler.requests[1]["body"])
            self.assertEqual(sent["method"], "tools/call")
            self.assertEqual(sent["params"]["name"], "get_catalog_summary")
            self.assertEqual(sent["params"]["arguments"]["format"], "brief")

            RecordingHandler.next_response = (401, "application/json", '{"error":"login-required"}', {})
            err = io.StringIO()
            with redirect_stderr(err):
                rc3 = rab.main(["brief"])
            self.assertEqual(rc3, 1)
            self.assertIn("401 login-required", err.getvalue())
        finally:
            os.environ.clear()
            os.environ.update(old)

    def test_from_env_precedence_and_search_graph_cli_flags(self) -> None:
        old = os.environ.copy()
        try:
            os.environ["RAB_URL"] = self.base_url
            os.environ["RAB_USER"] = "envuser"
            os.environ["RAB_PASSWORD"] = "envpass"

            # Explicit CLI token overrides RAB_USER/RAB_PASSWORD without ValueError
            RecordingHandler.next_response = (200, "text/plain", "ok\n", {})
            with redirect_stdout(io.StringIO()):
                rc = rab.main(["--token", "cli-pat", "brief"])
            self.assertEqual(rc, 0)
            self.assertEqual(RecordingHandler.requests[0]["headers"]["authorization"], "Bearer cli-pat")

            # Explicit CLI user/password overrides RAB_TOKEN
            os.environ["RAB_TOKEN"] = "env-pat"
            RecordingHandler.next_response = (200, "text/plain", "ok\n", {})
            with redirect_stdout(io.StringIO()):
                rc2 = rab.main(["--user", "cliuser", "--password", "clipass", "brief"])
            self.assertEqual(rc2, 0)
            expected_basic = "Basic " + base64.b64encode(b"cliuser:clipass").decode("ascii")
            self.assertEqual(RecordingHandler.requests[1]["headers"]["authorization"], expected_basic)

            # When both RAB_TOKEN and RAB_USER exist without CLI flags, RAB_TOKEN wins cleanly
            c = rab.RabClient.from_env()
            self.assertEqual(c._auth_header, "Bearer env-pat")

            # search --deprecated & graph extra flags
            RecordingHandler.next_response = (200, "text/markdown", "# ops\n", {})
            with redirect_stdout(io.StringIO()):
                rc3 = rab.main(["search", "issue", "--deprecated", "true"])
            self.assertEqual(rc3, 0)
            qs3 = urllib.parse.parse_qs(urllib.parse.urlparse(RecordingHandler.requests[2]["path"]).query)
            self.assertEqual(qs3["deprecated"], ["true"])

            RecordingHandler.next_response = (200, "application/json", '{"nodes":[]}', {})
            with redirect_stdout(io.StringIO()):
                rc4 = rab.main([
                    "graph", "--class", "com.example.Demo", "--include-sources",
                    "--decompiler", "cfr", "--include-jdk", "--exclude-libraries",
                ])
            self.assertEqual(rc4, 0)
            qs4 = urllib.parse.parse_qs(urllib.parse.urlparse(RecordingHandler.requests[3]["path"]).query)
            self.assertEqual(qs4["includeSources"], ["true"])
            self.assertEqual(qs4["decompiler"], ["cfr"])
            self.assertEqual(qs4["includeJdk"], ["true"])
            self.assertEqual(qs4["excludeLibraries"], ["true"])
        finally:
            os.environ.clear()
            os.environ.update(old)

    def test_resolve_cli_does_not_clobber_base_url(self) -> None:
        old = os.environ.copy()
        try:
            for k in ("RAB_URL", "RAB_USER", "RAB_PASSWORD", "RAB_TOKEN"):
                os.environ.pop(k, None)

            RecordingHandler.next_response = (200, "text/markdown", "# resolved\n", {})
            with redirect_stdout(io.StringIO()):
                rc1 = rab.main(["--url", self.base_url, "resolve", "/rest/api/2/serverInfo", "--method", "GET"])
            self.assertEqual(rc1, 0)
            p1 = urllib.parse.urlparse(RecordingHandler.requests[0]["path"])
            self.assertEqual(p1.path, "/jira/rest/restbrowser/1/catalog/resolve")
            qs1 = urllib.parse.parse_qs(p1.query)
            self.assertEqual(qs1["url"], ["/rest/api/2/serverInfo"])
            self.assertEqual(qs1["method"], ["GET"])

            os.environ["RAB_URL"] = self.base_url
            RecordingHandler.next_response = (200, "text/markdown", "# resolved\n", {})
            with redirect_stdout(io.StringIO()):
                rc2 = rab.main(["resolve", "/rest/api/2/serverInfo"])
            self.assertEqual(rc2, 0)
            p2 = urllib.parse.urlparse(RecordingHandler.requests[1]["path"])
            self.assertEqual(p2.path, "/jira/rest/restbrowser/1/catalog/resolve")
            qs2 = urllib.parse.parse_qs(p2.query)
            self.assertEqual(qs2["url"], ["/rest/api/2/serverInfo"])
        finally:
            os.environ.clear()
            os.environ.update(old)

    def _run_cli(self, argv, *, status=200, ctype="application/json", payload='{"ok":true}'):
        RecordingHandler.requests.clear()
        RecordingHandler.next_response = (status, ctype, payload, {})
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = rab.main(argv)
        self.assertEqual(rc, 0, f"argv={argv!r}")
        req = RecordingHandler.requests[0]
        parsed = urllib.parse.urlparse(req["path"])
        return buf.getvalue(), req, parsed.path, urllib.parse.parse_qs(parsed.query)

    def test_remaining_cli_subcommands_dispatch_and_format(self) -> None:
        old = os.environ.copy()
        try:
            os.environ["RAB_URL"] = self.base_url
            os.environ["RAB_TOKEN"] = "cli-pat"

            _, _, path, qs = self._run_cli(["catalog"])
            self.assertEqual(path, "/jira/rest/restbrowser/1/catalog")
            self.assertEqual(qs, {})

            _, _, path, qs = self._run_cli(["openapi"])
            self.assertEqual(path, "/jira/rest/restbrowser/1/openapi")
            self.assertEqual(qs, {})

            _, _, path, qs = self._run_cli(["openapi", "--module", "jira:api2", "--no-schemas", "--depth", "1"])
            self.assertEqual(path, "/jira/rest/restbrowser/1/catalog/openapi")
            self.assertEqual(qs, {"module": ["jira:api2"], "includeSchemas": ["false"], "schemaDepth": ["1"]})

            _, req, path, _ = self._run_cli(
                [
                    "--max-chars", "900", "context",
                    "--url", "/rest/api/2/serverInfo", "--method", "GET",
                    "--depth", "2", "--max-lines", "50", "--no-schemas", "--no-impls", "--no-source", "--decompiler", "cfr",
                ],
                ctype="text/markdown",
                payload="# ctx\n",
            )
            self.assertEqual(req["method"], "POST")
            self.assertEqual(path, "/jira/rest/restbrowser/1/code/context")
            self.assertEqual(
                json.loads(req["body"]),
                {
                    "schemaDepth": 2,
                    "maxLines": 50,
                    "includeSchemas": False,
                    "includeImplementations": False,
                    "includeSource": False,
                    "lineNumbers": True,
                    "decompiler": "cfr",
                    "format": "markdown",
                    "url": "/rest/api/2/serverInfo",
                    "method": "GET",
                    "maxChars": 900,
                },
            )

            _, _, path, qs = self._run_cli(
                ["operation", "jira:api2:GET:serverInfo", "--scope", "class", "--decompiler", "cfr", "--view", "full", "--start-line", "5", "--max-lines", "20"],
                ctype="text/markdown",
                payload="# op\n",
            )
            self.assertEqual(path, "/jira/rest/restbrowser/1/code/operation")
            self.assertEqual(
                qs,
                {
                    "op": ["jira:api2:GET:serverInfo"],
                    "scope": ["class"],
                    "decompiler": ["cfr"],
                    "view": ["full"],
                    "startLine": ["5"],
                    "maxLines": ["20"],
                    "lineNumbers": ["true"],
                    "format": ["markdown"],
                },
            )

            _, _, path, qs = self._run_cli(
                ["class", "--class", "com.example.Demo", "--from-bundle", "7", "--view", "full", "--outline", "--impls"],
                ctype="text/markdown",
                payload="# class\n",
            )
            self.assertEqual(path, "/jira/rest/restbrowser/1/code/class")
            self.assertEqual(
                qs,
                {
                    "class": ["com.example.Demo"],
                    "fromBundle": ["7"],
                    "view": ["full"],
                    "outline": ["true"],
                    "includeImplementations": ["true"],
                    "format": ["markdown"],
                },
            )

            _, req, path, qs = self._run_cli(
                ["source", "--class", "com.example.Demo", "--method", "run", "--scope", "method", "--decompiler", "cfr", "--text"],
                ctype="text/plain",
                payload="void run() {}\n",
            )
            self.assertEqual(path, "/jira/rest/restbrowser/1/code/source")
            self.assertEqual(qs["format"], ["text"])
            self.assertEqual(req["headers"]["accept"], "text/plain")

            _, _, path, qs = self._run_cli(
                ["schema", "--class", "com.example.Dto", "--depth", "2", "--no-example"],
                ctype="text/markdown",
                payload="# schema\n",
            )
            self.assertEqual(path, "/jira/rest/restbrowser/1/code/schema")
            self.assertEqual(qs, {"class": ["com.example.Dto"], "depth": ["2"], "includeExample": ["false"], "format": ["markdown"]})

            impl_json = json.dumps(
                {
                    "target": "com.example.Svc",
                    "serviceCount": 1,
                    "implementationCount": 1,
                    "bundleId": 5,
                    "osgiServices": [{"serviceId": 9, "bundleId": 5, "plugin": "com.example.app", "beanName": "svc", "objectClass": ["com.example.Svc"]}],
                    "implementations": [{"class": "com.example.SvcImpl", "via": "class", "bundleId": 5, "plugin": "com.example.app"}],
                }
            )
            out, _, path, qs = self._run_cli(["impls", "--class", "com.example.Svc", "--bundle-id", "5", "--include-abstract", "--limit", "10"], payload=impl_json)
            self.assertEqual(path, "/jira/rest/restbrowser/1/code/implementations")
            self.assertEqual(qs, {"class": ["com.example.Svc"], "bundleId": ["5"], "includeAbstract": ["true"], "limit": ["10"]})
            self.assertIn("SERVICE\tid=9", out)
            self.assertIn("IMPL\tcom.example.SvcImpl", out)

            out_json, _, _, _ = self._run_cli(["--json", "impls", "--class", "com.example.Svc"], payload=impl_json)
            self.assertEqual(json.loads(out_json)["bundleId"], 5)

            caller_json = json.dumps({"target": "com.example.Svc", "method": "ping", "count": 1, "scannedClasses": 4, "results": [{"class": "com.example.Web", "bundleId": 5, "plugin": "com.example.app", "calls": ["ping()"]}]})
            out, _, path, qs = self._run_cli(["callers", "--class", "com.example.Svc", "--method", "ping", "--package-prefix", "com.example", "--limit", "15"], payload=caller_json)
            self.assertEqual(path, "/jira/rest/restbrowser/1/code/callers")
            self.assertEqual(qs, {"class": ["com.example.Svc"], "method": ["ping"], "packagePrefix": ["com.example"], "limit": ["15"]})
            self.assertIn("com.example.Web", out)

            grep_json = json.dumps({"query": "secretToken", "count": 1, "scannedClasses": 3, "results": [{"class": "com.example.Auth", "bundleId": 5, "plugin": "com.example.app", "matches": ["secretToken"]}]})
            out, _, path, qs = self._run_cli(["grep", "secretToken", "--bundle-id", "5", "--plugin", "com.example.app", "--package-prefix", "com.example", "--case-sensitive", "--limit", "12"], payload=grep_json)
            self.assertEqual(path, "/jira/rest/restbrowser/1/code/grep")
            self.assertEqual(qs, {"q": ["secretToken"], "bundleId": ["5"], "plugin": ["com.example.app"], "packagePrefix": ["com.example"], "caseSensitive": ["true"], "includeUtf8": ["true"], "limit": ["12"]})
            self.assertIn("com.example.Auth", out)

            _, _, path, qs = self._run_cli(["resource", "--bundle-id", "42", "--prefix", "templates/", "--limit", "10"], ctype="text/markdown", payload="# files\n")
            self.assertEqual(path, "/jira/rest/restbrowser/1/code/resource")
            self.assertEqual(qs, {"bundleId": ["42"], "prefix": ["templates/"], "maxLines": ["200"], "lineNumbers": ["true"], "limit": ["10"], "format": ["markdown"]})

            _, _, path, qs = self._run_cli(["--json", "resource", "--bundle-id", "42", "--path", "atlassian-plugin.xml", "--start-line", "1", "--max-lines", "50"])
            self.assertEqual(path, "/jira/rest/restbrowser/1/code/resource")
            self.assertNotIn("format", qs)
            self.assertEqual(qs["path"], ["atlassian-plugin.xml"])

            _, _, path, qs = self._run_cli(["plugin", "com.example.app", "--view", "full"])
            self.assertEqual(path, "/jira/rest/restbrowser/1/code/plugin")
            self.assertEqual(qs, {"key": ["com.example.app"], "view": ["full"]})

            _, _, path, _ = self._run_cli(["echo"])
            self.assertEqual(path, "/jira/rest/restbrowser/1/echo")

            _, req, path, _ = self._run_cli(["mcp", "resources/read", "--uri", "rab://catalog/brief"])
            self.assertEqual(path, "/jira/rest/restbrowser/1/mcp")
            self.assertEqual(json.loads(req["body"])["params"], {"uri": "rab://catalog/brief"})

            _, req, _, _ = self._run_cli(["mcp", "prompts/get", "--name", "explore-endpoint-payload", "--args", '{"query":"issue"}'])
            self.assertEqual(json.loads(req["body"])["params"], {"name": "explore-endpoint-payload", "arguments": {"query": "issue"}})

            _, req, _, _ = self._run_cli(["mcp", "tools/list", "--params", "{}"])
            self.assertEqual(json.loads(req["body"])["params"], {})
        finally:
            os.environ.clear()
            os.environ.update(old)


if __name__ == "__main__":
    unittest.main()
