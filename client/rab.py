#!/usr/bin/env python3
"""Zero-dependency Python client and CLI for REST API Browser (Atlassian Data Center).

Designed for AI coding agents and diagnostic scripts: supports PAT (Bearer) and Basic
authentication, sticky cluster session cookies, automatic XSRF headers on writes,
Markdown/brief outputs by default with configurable `--max-chars` clipping, and an MCP
JSON-RPC helper. Uses only the Python 3.9+ standard library.
"""

from __future__ import annotations

import argparse
import base64
import http.cookiejar
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple, Union

REST_PREFIX = "/rest/restbrowser/1"
XSRF_HEADER = {"X-Atlassian-Token": "no-check"}
DEFAULT_MAX_CHARS = 6000


class RabError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: int = 0,
        code: str = "",
        detail: str = "",
        hint: str = "",
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.detail = detail
        self.hint = hint


def _qs(params: Dict[str, Any]) -> str:
    clean: Dict[str, Any] = {}
    for k, v in params.items():
        if v is None or v == "":
            continue
        if isinstance(v, bool):
            clean[k] = "true" if v else "false"
        else:
            clean[k] = v
    return ("?" + urllib.parse.urlencode(clean)) if clean else ""


def clip_output(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    omitted = len(text) - max_chars
    return text[:max_chars].rstrip() + f"\n[... truncated {omitted} chars; narrow query/flags or pass --max-chars 0]\n"


class RabClient:
    """Thin stdlib HTTP client for REST API Browser Agent API & MCP."""

    node_headers = ("X-Node-Id", "X-ANODEID")

    def __init__(
        self,
        base_url: str,
        *,
        user: Optional[str] = None,
        password: Optional[str] = None,
        token: Optional[str] = None,
        insecure: bool = False,
        ca_file: Optional[str] = None,
        timeout: float = 60.0,
    ) -> None:
        clean_url = (base_url or "").strip().rstrip("/")
        if not clean_url:
            raise ValueError("base_url is required (pass --url or set $RAB_URL)")
        self.base_url = clean_url
        self.timeout = float(timeout)

        if token and (user or password):
            raise ValueError("Do not mix token and user/password")
        self._auth_header: Optional[str] = None
        if token:
            self._auth_header = f"Bearer {token.strip()}"
        elif user is not None or password is not None:
            raw = base64.b64encode(f"{user or ''}:{password or ''}".encode("utf-8")).decode("ascii")
            self._auth_header = "Basic " + raw

        self._ctx = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
        if insecure:
            self._ctx.check_hostname = False
            self._ctx.verify_mode = ssl.CERT_NONE

        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=self._ctx),
            urllib.request.HTTPCookieProcessor(self._jar),
        )
        self.last_node: Optional[str] = None

    @classmethod
    def from_env(
        cls,
        *,
        base_url: Optional[str] = None,
        user: Optional[str] = None,
        password: Optional[str] = None,
        token: Optional[str] = None,
        insecure: bool = False,
        ca_file: Optional[str] = None,
        timeout: float = 60.0,
    ) -> "RabClient":
        if token is not None and (user is not None or password is not None):
            raise ValueError("Do not mix token and user/password")
        if token is not None:
            eff_token: Optional[str] = token
            eff_user: Optional[str] = None
            eff_password: Optional[str] = None
        elif user is not None or password is not None:
            eff_token = None
            eff_user = user if user is not None else os.environ.get("RAB_USER")
            eff_password = password if password is not None else os.environ.get("RAB_PASSWORD")
        else:
            env_token = os.environ.get("RAB_TOKEN")
            if env_token:
                eff_token = env_token
                eff_user = None
                eff_password = None
            else:
                eff_token = None
                eff_user = os.environ.get("RAB_USER")
                eff_password = os.environ.get("RAB_PASSWORD")
        return cls(
            base_url if base_url is not None else os.environ.get("RAB_URL", ""),
            user=eff_user,
            password=eff_password,
            token=eff_token,
            insecure=insecure,
            ca_file=ca_file if ca_file is not None else os.environ.get("SSL_CERT_FILE"),
            timeout=timeout,
        )

    # ---------- low-level HTTP ----------

    def request_raw(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Dict[str, Any]] = None,
        accept: str = "*/*",
        xsrf: Optional[bool] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Tuple[int, Dict[str, str], bytes]:
        url = path if path.startswith(("http://", "https://")) else self.base_url + path
        upper = method.upper()
        headers: Dict[str, str] = {"Accept": accept, "User-Agent": "rest-api-browser-client"}
        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif upper == "POST":
            data = b""
        send_xsrf = (upper == "POST") if xsrf is None else xsrf
        if send_xsrf:
            headers.update(XSRF_HEADER)
        if self._auth_header:
            headers["Authorization"] = self._auth_header
        if extra_headers:
            headers.update(extra_headers)

        req = urllib.request.Request(url, data=data, headers=headers, method=upper)
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                hdrs = {k.lower(): v for k, v in resp.headers.items()}
                self._remember_node(hdrs)
                return resp.status, hdrs, resp.read()
        except urllib.error.HTTPError as exc:
            hdrs = {k.lower(): v for k, v in exc.headers.items()} if exc.headers else {}
            self._remember_node(hdrs)
            try:
                payload = exc.read()
            except Exception:
                payload = b""
            return exc.code, hdrs, payload

    def api_text(
        self,
        method: str,
        endpoint: str,
        *,
        body: Optional[Dict[str, Any]] = None,
        accept: str = "text/markdown, text/plain;q=0.9, application/json;q=0.5",
    ) -> str:
        status, _hdrs, raw = self.request_raw(method, REST_PREFIX + endpoint, body=body, accept=accept)
        text = raw.decode("utf-8", "replace")
        if status >= 400:
            self._raise_error(status, text)
        return text

    def api_json(self, method: str, endpoint: str, *, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        status, _hdrs, raw = self.request_raw(
            method, REST_PREFIX + endpoint, body=body, accept="application/json"
        )
        text = raw.decode("utf-8", "replace")
        if status >= 400:
            self._raise_error(status, text)
        try:
            parsed = json.loads(text)
        except ValueError as exc:
            raise RabError(f"Expected JSON from {endpoint}, got: {text[:120]!r}", status=status) from exc
        if not isinstance(parsed, dict):
            raise RabError(f"Unexpected JSON type from {endpoint}", status=status)
        return parsed

    def _remember_node(self, hdrs: Dict[str, str]) -> None:
        for h in self.node_headers:
            v = hdrs.get(h.lower())
            if v:
                self.last_node = v
                return

    @staticmethod
    def _raise_error(status: int, text: str) -> None:
        code, detail, hint = "", "", ""
        try:
            payload = json.loads(text)
            if isinstance(payload, dict):
                code = str(payload.get("error") or "")
                detail = str(payload.get("detail") or payload.get("message") or "")
                hint = str(payload.get("hint") or "")
        except ValueError:
            pass
        msg = f"HTTP {status}"
        if code:
            msg += f" {code}"
        if detail:
            msg += f": {detail}"
        elif not code and text.strip():
            msg += f": {text.strip()[:160]}"
        if hint:
            msg += f" (hint: {hint})"
        raise RabError(msg, status=status, code=code, detail=detail, hint=hint)

    # ---------- high-level workflows ----------

    def brief(self, *, top: int = 12, as_json: bool = False) -> Union[str, Dict[str, Any]]:
        if as_json:
            return self.api_json("GET", "/catalog")
        return self.api_text("GET", "/catalog/brief" + _qs({"top": top}), accept="text/plain")

    def catalog(self) -> Dict[str, Any]:
        return self.api_json("GET", "/catalog")

    def search(
        self,
        q: str = "",
        *,
        method: str = "",
        path: str = "",
        module: str = "",
        plugin: str = "",
        access: str = "",
        deprecated: Optional[bool] = None,
        uses_class: str = "",
        limit: int = 25,
        offset: int = 0,
        fields: str = "compact",
        as_json: bool = False,
    ) -> Union[str, Dict[str, Any]]:
        params: Dict[str, Any] = {
            "q": q,
            "method": method,
            "path": path,
            "module": module,
            "plugin": plugin,
            "access": access,
            "deprecated": deprecated,
            "usesClass": uses_class,
            "limit": limit,
            "offset": offset,
            "fields": fields,
        }
        if not as_json:
            params["format"] = "markdown"
        ep = "/catalog/operations" + _qs(params)
        return self.api_json("GET", ep) if as_json else self.api_text("GET", ep)

    def resolve(
        self, url: str, *, method: str = "", limit: int = 10, as_json: bool = False
    ) -> Union[str, Dict[str, Any]]:
        params: Dict[str, Any] = {"url": url, "method": method, "limit": limit}
        if not as_json:
            params["format"] = "markdown"
        ep = "/catalog/resolve" + _qs(params)
        return self.api_json("GET", ep) if as_json else self.api_text("GET", ep)

    def openapi(
        self, *, module: str = "", include_schemas: bool = True, schema_depth: int = 2
    ) -> Dict[str, Any]:
        if module:
            ep = "/catalog/openapi" + _qs(
                {"module": module, "includeSchemas": include_schemas, "schemaDepth": schema_depth}
            )
            return self.api_json("GET", ep)
        return self.api_json("GET", "/openapi")

    def context(
        self,
        *,
        op: str = "",
        url: str = "",
        method: str = "",
        max_lines: int = 250,
        max_chars: Optional[int] = None,
        schema_depth: int = 3,
        include_schemas: bool = True,
        include_impls: bool = True,
        include_source: bool = True,
        line_numbers: bool = True,
        decompiler: str = "vineflower",
        as_json: bool = False,
    ) -> Union[str, Dict[str, Any]]:
        if not op and not url:
            raise ValueError("Pass either op or url to context()")
        body: Dict[str, Any] = {
            "maxLines": max_lines,
            "schemaDepth": schema_depth,
            "includeSchemas": include_schemas,
            "includeImplementations": include_impls,
            "includeSource": include_source,
            "lineNumbers": line_numbers,
            "decompiler": decompiler,
            "format": "json" if as_json else "markdown",
        }
        if op:
            body["op"] = op
        if url:
            body["url"] = url
        if method:
            body["method"] = method
        if max_chars is not None and max_chars > 0:
            body["maxChars"] = max_chars
        return self.api_json("POST", "/code/context", body=body) if as_json else self.api_text("POST", "/code/context", body=body)

    def operation(
        self,
        op: str,
        *,
        scope: str = "method",
        decompiler: str = "vineflower",
        view: str = "compact",
        start_line: Optional[int] = None,
        max_lines: Optional[int] = None,
        line_numbers: bool = True,
        as_json: bool = False,
    ) -> Union[str, Dict[str, Any]]:
        params: Dict[str, Any] = {
            "op": op,
            "scope": scope,
            "decompiler": decompiler,
            "view": view,
            "startLine": start_line,
            "maxLines": max_lines,
            "lineNumbers": line_numbers,
        }
        if not as_json:
            params["format"] = "markdown"
        ep = "/code/operation" + _qs(params)
        return self.api_json("GET", ep) if as_json else self.api_text("GET", ep)

    def inspect_class(
        self,
        *,
        class_name: str = "",
        op: str = "",
        from_bundle: Optional[int] = None,
        view: str = "compact",
        outline: bool = False,
        include_impls: bool = False,
        as_json: bool = False,
    ) -> Union[str, Dict[str, Any]]:
        params: Dict[str, Any] = {
            "class": class_name,
            "op": op,
            "fromBundle": from_bundle,
            "view": view,
            "outline": outline,
            "includeImplementations": include_impls,
        }
        if not as_json:
            params["format"] = "markdown"
        ep = "/code/class" + _qs(params)
        return self.api_json("GET", ep) if as_json else self.api_text("GET", ep)

    def source(
        self,
        *,
        class_name: str = "",
        op: str = "",
        method: str = "",
        scope: str = "class",
        decompiler: str = "vineflower",
        from_bundle: Optional[int] = None,
        start_line: Optional[int] = None,
        max_lines: Optional[int] = 200,
        include_meta: bool = False,
        line_numbers: bool = True,
        text_only: bool = False,
        as_json: bool = False,
    ) -> Union[str, Dict[str, Any]]:
        fmt = "json" if as_json else ("text" if text_only else "markdown")
        ep = "/code/source" + _qs(
            {
                "class": class_name,
                "op": op,
                "method": method,
                "scope": scope,
                "decompiler": decompiler,
                "fromBundle": from_bundle,
                "startLine": start_line,
                "maxLines": max_lines,
                "includeMeta": include_meta,
                "lineNumbers": line_numbers,
                "format": fmt,
            }
        )
        if as_json:
            return self.api_json("GET", ep)
        return self.api_text("GET", ep, accept="text/plain" if text_only else "text/markdown, text/plain;q=0.9")

    def schema(
        self,
        *,
        class_name: str = "",
        op: str = "",
        from_bundle: Optional[int] = None,
        depth: int = 3,
        include_example: bool = True,
        as_json: bool = False,
    ) -> Union[str, Dict[str, Any]]:
        params: Dict[str, Any] = {
            "class": class_name,
            "op": op,
            "fromBundle": from_bundle,
            "depth": depth,
            "includeExample": include_example,
        }
        if not as_json:
            params["format"] = "markdown"
        ep = "/code/schema" + _qs(params)
        return self.api_json("GET", ep) if as_json else self.api_text("GET", ep)

    def impls(
        self,
        *,
        class_name: str = "",
        op: str = "",
        from_bundle: Optional[int] = None,
        bundle_id: Optional[int] = None,
        plugin: str = "",
        include_abstract: bool = False,
        limit: int = 30,
    ) -> Dict[str, Any]:
        return self.api_json(
            "GET",
            "/code/implementations"
            + _qs(
                {
                    "class": class_name,
                    "op": op,
                    "fromBundle": from_bundle,
                    "bundleId": bundle_id,
                    "plugin": plugin,
                    "includeAbstract": include_abstract,
                    "limit": limit,
                }
            ),
        )

    def callers(
        self,
        *,
        class_name: str = "",
        method: str = "",
        op: str = "",
        from_bundle: Optional[int] = None,
        bundle_id: Optional[int] = None,
        plugin: str = "",
        package_prefix: str = "",
        limit: int = 50,
    ) -> Dict[str, Any]:
        return self.api_json(
            "GET",
            "/code/callers"
            + _qs(
                {
                    "class": class_name,
                    "method": method,
                    "op": op,
                    "fromBundle": from_bundle,
                    "bundleId": bundle_id,
                    "plugin": plugin,
                    "packagePrefix": package_prefix,
                    "limit": limit,
                }
            ),
        )

    def grep(
        self,
        q: str,
        *,
        bundle_id: Optional[int] = None,
        plugin: str = "",
        package_prefix: str = "",
        case_sensitive: bool = False,
        include_utf8: bool = True,
        limit: int = 50,
    ) -> Dict[str, Any]:
        return self.api_json(
            "GET",
            "/code/grep"
            + _qs(
                {
                    "q": q,
                    "bundleId": bundle_id,
                    "plugin": plugin,
                    "packagePrefix": package_prefix,
                    "caseSensitive": case_sensitive,
                    "includeUtf8": include_utf8,
                    "limit": limit,
                }
            ),
        )

    def graph(
        self,
        *,
        class_name: str = "",
        op: str = "",
        from_bundle: Optional[int] = None,
        depth: int = 1,
        max_nodes: int = 30,
        preset: str = "domain",
        edge_kinds: str = "",
        include_jdk: bool = False,
        exclude_libraries: bool = False,
        package_prefix: str = "",
        include_sources: bool = False,
        decompiler: str = "vineflower",
    ) -> Dict[str, Any]:
        return self.api_json(
            "GET",
            "/code/graph"
            + _qs(
                {
                    "class": class_name,
                    "op": op,
                    "fromBundle": from_bundle,
                    "depth": depth,
                    "maxNodes": max_nodes,
                    "preset": preset,
                    "edgeKinds": edge_kinds,
                    "includeJdk": include_jdk,
                    "excludeLibraries": exclude_libraries,
                    "packagePrefix": package_prefix,
                    "includeSources": include_sources,
                    "decompiler": decompiler,
                }
            ),
        )

    def resource(
        self,
        *,
        bundle_id: Optional[int] = None,
        plugin: str = "",
        path: str = "",
        prefix: str = "",
        start_line: Optional[int] = None,
        max_lines: Optional[int] = 200,
        line_numbers: bool = True,
        limit: int = 100,
        as_json: bool = False,
    ) -> Union[str, Dict[str, Any]]:
        params: Dict[str, Any] = {
            "bundleId": bundle_id,
            "plugin": plugin,
            "path": path,
            "prefix": prefix,
            "startLine": start_line,
            "maxLines": max_lines,
            "lineNumbers": line_numbers,
            "limit": limit,
        }
        if not as_json:
            params["format"] = "markdown"
        ep = "/code/resource" + _qs(params)
        return self.api_json("GET", ep) if as_json else self.api_text("GET", ep)

    def plugin(self, key: str, *, view: str = "compact") -> Dict[str, Any]:
        return self.api_json("GET", "/code/plugin" + _qs({"key": key, "view": view}))

    def echo(self) -> Dict[str, Any]:
        return self.api_json("GET", "/echo")

    def mcp(
        self, rpc_method: str, params: Optional[Dict[str, Any]] = None, *, rpc_id: int = 1
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"jsonrpc": "2.0", "id": rpc_id, "method": rpc_method}
        if params is not None:
            payload["params"] = params
        return self.api_json("POST", "/mcp", body=payload)


# ---------- compact formatters ----------


def format_impls(data: Dict[str, Any]) -> str:
    lines = [
        f"# Implementations of {data.get('target')} (services={data.get('serviceCount', 0)}, "
        f"impls={data.get('implementationCount', 0)}, bundle={data.get('bundleId')})"
    ]
    for s in data.get("osgiServices") or []:
        lines.append(
            f"SERVICE\tid={s.get('serviceId')}\tbundle={s.get('bundleId')}\tplugin={s.get('plugin') or '-'}\t"
            f"bean={s.get('beanName') or '-'}\toc={','.join(s.get('objectClass') or [])}"
        )
    for impl in data.get("implementations") or []:
        lines.append(
            f"IMPL\t{impl.get('class')}\tvia={impl.get('via')}\tbundle={impl.get('bundleId')}\t"
            f"plugin={impl.get('plugin') or '-'}"
        )
    return "\n".join(lines) + "\n"


def format_callers(data: Dict[str, Any]) -> str:
    lines = [
        f"# Callers of {data.get('target')}"
        + (f"#{data['method']}" if data.get("method") else "")
        + f" (count={data.get('count', 0)}, scannedClasses={data.get('scannedClasses', 0)})"
    ]
    for hit in data.get("results") or []:
        lines.append(
            f"{hit.get('class')}\tbundle={hit.get('bundleId')}\tplugin={hit.get('plugin') or '-'}\t"
            f"calls={'; '.join(hit.get('calls') or [])}"
        )
    return "\n".join(lines) + "\n"


def format_grep(data: Dict[str, Any]) -> str:
    lines = [f"# Grep {data.get('query')!r} (count={data.get('count', 0)}, scannedClasses={data.get('scannedClasses', 0)})"]
    for hit in data.get("results") or []:
        lines.append(
            f"{hit.get('class')}\tbundle={hit.get('bundleId')}\tplugin={hit.get('plugin') or '-'}\t"
            f"{' | '.join(hit.get('matches') or [])}"
        )
    return "\n".join(lines) + "\n"


# ---------- CLI ----------


def _add_target_args(sp: argparse.ArgumentParser) -> None:
    sp.add_argument("--class", dest="class_name", default="", help="Fully qualified Java class name")
    sp.add_argument("--op", default="", help="Operation key")
    sp.add_argument("--from-bundle", type=int, default=None, help="Disambiguating OSGi bundle ID")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="rab.py",
        description="Token-efficient CLI for REST API Browser (catalog, decompiler & code intelligence).",
    )
    p.add_argument("--url", help="Base URL (default: $RAB_URL)")
    p.add_argument("--user", help="Username (default: $RAB_USER)")
    p.add_argument("--password", help="Password (default: $RAB_PASSWORD)")
    p.add_argument("--token", help="Bearer PAT (default: $RAB_TOKEN)")
    p.add_argument("--insecure", action="store_true", help="Disable TLS certificate verification")
    p.add_argument("--ca-file", help="CA bundle PEM path (default: $SSL_CERT_FILE)")
    p.add_argument("--timeout", type=float, default=60.0, help="HTTP timeout seconds (default: 60)")
    p.add_argument("--json", action="store_true", dest="as_json", help="Emit raw JSON instead of compact text/Markdown")
    p.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS, help="Output char cap (0=unlimited, default: 6000)")

    sub = p.add_subparsers(dest="cmd", required=True)

    pb = sub.add_parser("brief", help="Compact instance & catalog triage brief")
    pb.add_argument("--top", type=int, default=12, help="Top modules to list (default: 12)")

    sub.add_parser("catalog", help="Catalog summary JSON")

    ps = sub.add_parser("search", help="Search REST operations")
    ps.add_argument("q", nargs="?", default="", help="Free-text query")
    ps.add_argument("--method", default="")
    ps.add_argument("--path", default="")
    ps.add_argument("--module", default="")
    ps.add_argument("--plugin", default="")
    ps.add_argument("--access", default="")
    ps.add_argument("--deprecated", choices=("true", "false"), default=None)
    ps.add_argument("--uses-class", default="")
    ps.add_argument("--limit", type=int, default=25)
    ps.add_argument("--offset", type=int, default=0)
    ps.add_argument("--fields", choices=("compact", "full"), default="compact")

    pr = sub.add_parser("resolve", help="Match a concrete URL to JAX-RS operation keys")
    pr.add_argument("target_url", metavar="url", help="Path or full URL (e.g. /rest/api/2/issue/PROJ-1)")
    pr.add_argument("--method", default="")
    pr.add_argument("--limit", type=int, default=10)

    po = sub.add_parser("openapi", help="Fetch OpenAPI 3.1.0 spec (self or one module)")
    po.add_argument("--module", default="", help="Optional module ID for /catalog/openapi")
    po.add_argument("--no-schemas", action="store_true")
    po.add_argument("--depth", type=int, default=2)

    pc = sub.add_parser("context", help="One-shot operation context (metadata + DTO schemas + handler + impls)")
    pc.add_argument("--op", default="")
    pc.add_argument("--url", dest="target_url", default="")
    pc.add_argument("--method", default="")
    pc.add_argument("--max-lines", type=int, default=250)
    pc.add_argument("--depth", type=int, default=3)
    pc.add_argument("--no-schemas", action="store_true")
    pc.add_argument("--no-impls", action="store_true")
    pc.add_argument("--no-source", action="store_true")
    pc.add_argument("--decompiler", choices=("vineflower", "cfr"), default="vineflower")

    pop = sub.add_parser("operation", help="Combined operation reflection metadata + handler source")
    pop.add_argument("op", help="Operation key")
    pop.add_argument("--scope", choices=("method", "class"), default="method")
    pop.add_argument("--decompiler", choices=("vineflower", "cfr"), default="vineflower")
    pop.add_argument("--view", choices=("compact", "full"), default="compact")
    pop.add_argument("--start-line", type=int, default=None)
    pop.add_argument("--max-lines", type=int, default=200)

    pcl = sub.add_parser("class", help="Inspect Java class bytecode metadata & outline")
    _add_target_args(pcl)
    pcl.add_argument("--view", choices=("compact", "full"), default="compact")
    pcl.add_argument("--outline", action="store_true")
    pcl.add_argument("--impls", action="store_true")

    psr = sub.add_parser("source", help="Decompile Java class or handler method")
    _add_target_args(psr)
    psr.add_argument("--method", default="")
    psr.add_argument("--scope", choices=("class", "method"), default="class")
    psr.add_argument("--decompiler", choices=("vineflower", "cfr"), default="vineflower")
    psr.add_argument("--start-line", type=int, default=None)
    psr.add_argument("--max-lines", type=int, default=200)
    psr.add_argument("--text", action="store_true", help="Request text/plain source without Markdown wrapper")

    psc = sub.add_parser("schema", help="Draft 2020-12 JSON Schema & DTO example payload")
    _add_target_args(psc)
    psc.add_argument("--depth", type=int, default=3)
    psc.add_argument("--no-example", action="store_true")

    pi = sub.add_parser("impls", help="Find live OSGi services and concrete implementations")
    _add_target_args(pi)
    pi.add_argument("--bundle-id", type=int, default=None)
    pi.add_argument("--plugin", default="")
    pi.add_argument("--include-abstract", action="store_true")
    pi.add_argument("--limit", type=int, default=30)

    pcal = sub.add_parser("callers", help="Find constant-pool callers across wired OSGi bundles")
    _add_target_args(pcal)
    pcal.add_argument("--method", default="")
    pcal.add_argument("--bundle-id", type=int, default=None)
    pcal.add_argument("--plugin", default="")
    pcal.add_argument("--package-prefix", default="")
    pcal.add_argument("--limit", type=int, default=50)

    pgr = sub.add_parser("grep", help="Search bytecode constant-pool strings & UTF-8 literals")
    pgr.add_argument("q", help="Search string")
    pgr.add_argument("--bundle-id", type=int, default=None)
    pgr.add_argument("--plugin", default="")
    pgr.add_argument("--package-prefix", default="")
    pgr.add_argument("--case-sensitive", action="store_true")
    pgr.add_argument("--limit", type=int, default=50)

    pgraph = sub.add_parser("graph", help="Typed BFS dependency graph traversal")
    _add_target_args(pgraph)
    pgraph.add_argument("--depth", type=int, default=1)
    pgraph.add_argument("--max-nodes", type=int, default=30)
    pgraph.add_argument("--preset", default="domain")
    pgraph.add_argument("--edge-kinds", default="")
    pgraph.add_argument("--package-prefix", default="")
    pgraph.add_argument("--include-sources", action="store_true")
    pgraph.add_argument("--decompiler", choices=("vineflower", "cfr"), default="vineflower")
    pgraph.add_argument("--include-jdk", action="store_true")
    pgraph.add_argument("--exclude-libraries", action="store_true")

    pres = sub.add_parser("resource", help="List or read non-binary OSGi bundle resources")
    pres.add_argument("--bundle-id", type=int, default=None)
    pres.add_argument("--plugin", default="")
    pres.add_argument("--path", default="")
    pres.add_argument("--prefix", default="")
    pres.add_argument("--start-line", type=int, default=None)
    pres.add_argument("--max-lines", type=int, default=200)
    pres.add_argument("--limit", type=int, default=100)

    ppl = sub.add_parser("plugin", help="Inspect Atlassian plugin metadata and modules")
    ppl.add_argument("key", help="Plugin key")
    ppl.add_argument("--view", choices=("compact", "full"), default="compact")

    sub.add_parser("echo", help="Echo server-visible headers with credentials redacted")

    pmcp = sub.add_parser("mcp", help="Invoke built-in read-only MCP JSON-RPC endpoint")
    pmcp.add_argument("rpc_method", help="JSON-RPC method (e.g. tools/list, tools/call, resources/read)")
    pmcp.add_argument("--params", default=None, help="Raw JSON params object")
    pmcp.add_argument("--name", default=None, help="Shortcut name (tool or prompt name)")
    pmcp.add_argument("--args", dest="tool_args", default=None, help="Shortcut JSON arguments for tools/call or prompts/get")
    pmcp.add_argument("--uri", default=None, help="Shortcut resource URI for resources/read")

    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        client = RabClient.from_env(
            base_url=args.url,
            user=args.user,
            password=args.password,
            token=args.token,
            insecure=args.insecure,
            ca_file=args.ca_file,
            timeout=args.timeout,
        )

        out: Union[str, Dict[str, Any]]
        if args.cmd == "brief":
            out = client.brief(top=args.top, as_json=args.as_json)
        elif args.cmd == "catalog":
            out = client.catalog()
        elif args.cmd == "search":
            out = client.search(
                args.q,
                method=args.method,
                path=args.path,
                module=args.module,
                plugin=args.plugin,
                access=args.access,
                deprecated=(None if args.deprecated is None else args.deprecated == "true"),
                uses_class=args.uses_class,
                limit=args.limit,
                offset=args.offset,
                fields=args.fields,
                as_json=args.as_json,
            )
        elif args.cmd == "resolve":
            out = client.resolve(args.target_url, method=args.method, limit=args.limit, as_json=args.as_json)
        elif args.cmd == "openapi":
            out = client.openapi(
                module=args.module, include_schemas=not args.no_schemas, schema_depth=args.depth
            )
        elif args.cmd == "context":
            out = client.context(
                op=args.op,
                url=args.target_url,
                method=args.method,
                max_lines=args.max_lines,
                max_chars=args.max_chars if args.max_chars > 0 else None,
                schema_depth=args.depth,
                include_schemas=not args.no_schemas,
                include_impls=not args.no_impls,
                include_source=not args.no_source,
                decompiler=args.decompiler,
                as_json=args.as_json,
            )
        elif args.cmd == "operation":
            out = client.operation(
                args.op,
                scope=args.scope,
                decompiler=args.decompiler,
                view=args.view,
                start_line=args.start_line,
                max_lines=args.max_lines,
                as_json=args.as_json,
            )
        elif args.cmd == "class":
            out = client.inspect_class(
                class_name=args.class_name,
                op=args.op,
                from_bundle=args.from_bundle,
                view=args.view,
                outline=args.outline,
                include_impls=args.impls,
                as_json=args.as_json,
            )
        elif args.cmd == "source":
            out = client.source(
                class_name=args.class_name,
                op=args.op,
                method=args.method,
                scope=args.scope,
                decompiler=args.decompiler,
                from_bundle=args.from_bundle,
                start_line=args.start_line,
                max_lines=args.max_lines,
                text_only=args.text,
                as_json=args.as_json,
            )
        elif args.cmd == "schema":
            out = client.schema(
                class_name=args.class_name,
                op=args.op,
                from_bundle=args.from_bundle,
                depth=args.depth,
                include_example=not args.no_example,
                as_json=args.as_json,
            )
        elif args.cmd == "impls":
            res = client.impls(
                class_name=args.class_name,
                op=args.op,
                from_bundle=args.from_bundle,
                bundle_id=args.bundle_id,
                plugin=args.plugin,
                include_abstract=args.include_abstract,
                limit=args.limit,
            )
            out = res if args.as_json else format_impls(res)
        elif args.cmd == "callers":
            res = client.callers(
                class_name=args.class_name,
                method=args.method,
                op=args.op,
                from_bundle=args.from_bundle,
                bundle_id=args.bundle_id,
                plugin=args.plugin,
                package_prefix=args.package_prefix,
                limit=args.limit,
            )
            out = res if args.as_json else format_callers(res)
        elif args.cmd == "grep":
            res = client.grep(
                args.q,
                bundle_id=args.bundle_id,
                plugin=args.plugin,
                package_prefix=args.package_prefix,
                case_sensitive=args.case_sensitive,
                limit=args.limit,
            )
            out = res if args.as_json else format_grep(res)
        elif args.cmd == "graph":
            out = client.graph(
                class_name=args.class_name,
                op=args.op,
                from_bundle=args.from_bundle,
                depth=args.depth,
                max_nodes=args.max_nodes,
                preset=args.preset,
                edge_kinds=args.edge_kinds,
                include_jdk=args.include_jdk,
                exclude_libraries=args.exclude_libraries,
                package_prefix=args.package_prefix,
                include_sources=args.include_sources,
                decompiler=args.decompiler,
            )
        elif args.cmd == "resource":
            out = client.resource(
                bundle_id=args.bundle_id,
                plugin=args.plugin,
                path=args.path,
                prefix=args.prefix,
                start_line=args.start_line,
                max_lines=args.max_lines,
                limit=args.limit,
                as_json=args.as_json,
            )
        elif args.cmd == "plugin":
            out = client.plugin(args.key, view=args.view)
        elif args.cmd == "echo":
            out = client.echo()
        elif args.cmd == "mcp":
            params: Optional[Dict[str, Any]] = json.loads(args.params) if args.params else None
            if params is None:
                if args.name:
                    params = {"name": args.name}
                    if args.tool_args:
                        params["arguments"] = json.loads(args.tool_args)
                elif args.uri:
                    params = {"uri": args.uri}
            out = client.mcp(args.rpc_method, params)
        else:
            raise ValueError(f"Unknown command: {args.cmd}")

        text = json.dumps(out, separators=(",", ":")) + "\n" if isinstance(out, dict) else str(out)
        if not text.endswith("\n"):
            text += "\n"
        sys.stdout.write(clip_output(text, args.max_chars))
        return 0
    except ValueError as exc:
        sys.stderr.write(f"usage error: {exc}\n")
        return 2
    except RabError as exc:
        sys.stderr.write(f"rab error: {exc}\n")
        return 1
    except urllib.error.URLError as exc:
        sys.stderr.write(f"network error: {exc.reason}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
