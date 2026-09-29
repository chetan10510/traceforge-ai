"""Public-data provider adapters with consistent evidence contracts."""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any


USER_AGENT = "TraceForgeAI/1.0 portfolio-research"


@dataclass
class ProviderResult:
    provider: str
    status: str
    duration_ms: int
    records: list[dict[str, Any]]
    error: str | None = None
    cached: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def request_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    payload: dict[str, Any] | None = None,
    timeout: int = 22,
    attempts: int = 2,
) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    merged_headers = {"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})}
    if payload is not None:
        merged_headers["Content-Type"] = "application/json"
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, data=body, headers=merged_headers, method=method)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(0.5 * (2**attempt))
    raise RuntimeError(str(last_error or "provider request failed"))


def run_tavily(domain: str, query_context: str = "engineering") -> ProviderResult:
    started = time.monotonic()
    key = os.getenv("TAVILY_API_KEY", "")
    if not key:
        return _missing("tavily", started)
    try:
        data = request_json(
            "https://api.tavily.com/search",
            method="POST",
            payload={
                "api_key": key,
                "query": f'"{domain}" company {query_context} employees industry hiring technology official',
                "search_depth": "basic",
                "max_results": 6,
                "include_answer": False,
            },
        )
        records = [
            {
                "source_id": f"tavily-{index + 1}",
                "source_type": "search_result",
                "title": item.get("title") or "Search result",
                "url": item.get("url") or "",
                "content": item.get("content") or "",
                "score": item.get("score"),
            }
            for index, item in enumerate(data.get("results") or [])
            if item.get("url")
        ]
        return _result("tavily", records, started)
    except Exception as error:
        return _error("tavily", error, started)


def run_firecrawl(domain: str) -> ProviderResult:
    started = time.monotonic()
    key = os.getenv("FIRECRAWL_API_KEY", "")
    if not key:
        return _missing("firecrawl", started)
    try:
        target = f"https://{domain}"
        data = request_json(
            "https://api.firecrawl.dev/v1/scrape",
            method="POST",
            headers={"Authorization": f"Bearer {key}"},
            payload={"url": target, "formats": ["markdown"], "onlyMainContent": True},
            timeout=35,
        )
        envelope = data.get("data") if isinstance(data.get("data"), dict) else data
        markdown = str(envelope.get("markdown") or "")
        metadata = envelope.get("metadata") if isinstance(envelope.get("metadata"), dict) else {}
        records = []
        if markdown:
            records.append(
                {
                    "source_id": "firecrawl-homepage",
                    "source_type": "official_website",
                    "title": metadata.get("title") or domain,
                    "url": metadata.get("sourceURL") or target,
                    "content": markdown[:24000],
                    "description": metadata.get("description") or "",
                }
            )
        return _result("firecrawl", records, started)
    except Exception as error:
        return _error("firecrawl", error, started)


def run_github(domain: str, company_hint: str = "") -> ProviderResult:
    started = time.monotonic()
    token = os.getenv("GITHUB_TOKEN", "")
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    query = company_hint or domain.split(".")[0]
    try:
        search = request_json(
            "https://api.github.com/search/users?" + urllib.parse.urlencode({"q": f"{query} type:org", "per_page": 4}),
            headers=headers,
        )
        records: list[dict[str, Any]] = []
        normalized = re.sub(r"[^a-z0-9]", "", query.lower())
        for item in search.get("items") or []:
            login = str(item.get("login") or "")
            similarity = normalized in re.sub(r"[^a-z0-9]", "", login.lower())
            if not similarity and records:
                continue
            org = request_json(f"https://api.github.com/orgs/{urllib.parse.quote(login)}", headers=headers)
            records.append(
                {
                    "source_id": f"github-org-{login.lower()}",
                    "source_type": "github_organization",
                    "title": org.get("name") or login,
                    "url": org.get("html_url") or item.get("html_url") or "",
                    "content": org.get("description") or "",
                    "login": login,
                    "public_repos": org.get("public_repos"),
                    "followers": org.get("followers"),
                    "location": org.get("location"),
                    "blog": org.get("blog"),
                    "created_at": org.get("created_at"),
                    "match_basis": "normalized organization name",
                }
            )
            if records:
                break
        return _result("github", records, started)
    except Exception as error:
        return _error("github", error, started)


def _result(provider: str, records: list[dict[str, Any]], started: float) -> ProviderResult:
    return ProviderResult(provider, "success" if records else "no_match", _elapsed(started), records)


def _error(provider: str, error: Exception, started: float) -> ProviderResult:
    message = str(error)
    message = re.sub(r"(key|token)=[^&\s]+", r"\1=[redacted]", message, flags=re.I)
    return ProviderResult(provider, "error", _elapsed(started), [], message[:240])


def _missing(provider: str, started: float) -> ProviderResult:
    return ProviderResult(provider, "not_configured", _elapsed(started), [], "Provider key is not configured")


def _elapsed(started: float) -> int:
    return round((time.monotonic() - started) * 1000)

