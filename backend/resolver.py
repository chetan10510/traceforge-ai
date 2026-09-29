"""Evidence-first claim extraction and deterministic conflict handling."""

from __future__ import annotations

import json
import os
import re
from typing import Any

from .providers import ProviderResult, request_json


CLAIM_FIELDS = {"company_name", "summary", "industry", "headquarters", "founded_year", "product", "technology", "signal"}


def extract_claims(domain: str, results: list[ProviderResult]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    evidence = build_evidence(results)
    if not evidence:
        return [], {"provider": "deterministic", "status": "no_evidence"}
    key = os.getenv("GEMINI_API_KEY", "")
    if key:
        try:
            claims = _gemini_extract(domain, evidence, key)
            if claims:
                return resolve_claims(claims), {"provider": "gemini", "status": "success"}
        except Exception as error:
            model_status = {"provider": "gemini", "status": "fallback", "error": str(error)[:180]}
        else:
            model_status = {"provider": "gemini", "status": "fallback", "error": "No valid claims returned"}
    else:
        model_status = {"provider": "gemini", "status": "not_configured"}
    return resolve_claims(_fallback_claims(domain, evidence)), model_status


def build_evidence(results: list[ProviderResult]) -> list[dict[str, Any]]:
    evidence: list[dict[str, Any]] = []
    for result in results:
        for record in result.records:
            if not record.get("url"):
                continue
            evidence.append(
                {
                    "evidence_id": record.get("source_id"),
                    "provider": result.provider,
                    "source_type": record.get("source_type"),
                    "title": record.get("title"),
                    "url": record.get("url"),
                    "content": str(record.get("content") or "")[:9000],
                    "attributes": {key: value for key, value in record.items() if key not in {"content", "title", "url", "source_id", "source_type"}},
                }
            )
    return evidence


def resolve_claims(claims: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for claim in claims:
        field = str(claim.get("field") or "").strip().lower()
        value = claim.get("value")
        urls = [url for url in claim.get("source_urls", []) if isinstance(url, str) and url.startswith("http")]
        if field not in CLAIM_FIELDS or value in (None, "") or not urls:
            continue
        normalized = {
            "field": field,
            "value": value,
            "confidence": max(0.0, min(float(claim.get("confidence") or 0.5), 1.0)),
            "source_urls": list(dict.fromkeys(urls))[:5],
            "rationale": str(claim.get("rationale") or "Evidence-backed public claim")[:300],
        }
        grouped.setdefault(field, []).append(normalized)
    resolved: list[dict[str, Any]] = []
    for field, candidates in grouped.items():
        candidates.sort(key=lambda item: (len(item["source_urls"]), item["confidence"]), reverse=True)
        winner = candidates[0]
        alternatives = [item for item in candidates[1:] if _norm(item["value"]) != _norm(winner["value"])]
        resolved.append({**winner, "status": "conflict" if alternatives else "verified", "alternatives": alternatives[:3]})
    return sorted(resolved, key=lambda item: (item["field"] not in {"company_name", "summary", "industry"}, item["field"]))


def _gemini_extract(domain: str, evidence: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    allowed_urls = [item["url"] for item in evidence]
    model_evidence = [
        {
            "provider": item["provider"],
            "source_type": item["source_type"],
            "title": item["title"],
            "url": item["url"],
            "content": item["content"][:2800],
            "attributes": item["attributes"],
        }
        for item in evidence[:10]
    ]
    compact = json.dumps(model_evidence, ensure_ascii=True)[:24000]
    prompt = f"""You are a data quality extraction engine. Build claims about {domain} only from the evidence JSON below.
Return JSON only as {{"claims": [...]}}. Each claim requires: field, value, confidence from 0 to 1, source_urls, rationale.
Allowed fields: {sorted(CLAIM_FIELDS)}. Return at most one claim per field and at most 8 claims total. Keep every value and rationale concise; combine multiple products or technologies in one string.
Every source URL must exactly match an evidence URL. Do not infer employee counts, revenue, funding, or people. Preserve conflicting claims separately.
Allowed URLs: {json.dumps(allowed_urls)}
Evidence: {compact}"""
    data = request_json(
        f"https://generativelanguage.googleapis.com/v1beta/models/{urllib_quote(model)}:generateContent",
        method="POST",
        headers={"x-goog-api-key": key},
        payload={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "OBJECT",
                    "properties": {
                        "claims": {
                            "type": "ARRAY",
                            "maxItems": 8,
                            "items": {
                                "type": "OBJECT",
                                "properties": {
                                    "field": {"type": "STRING", "enum": sorted(CLAIM_FIELDS)},
                                    "value": {"type": "STRING", "maxLength": 600},
                                    "confidence": {"type": "NUMBER", "minimum": 0, "maximum": 1},
                                    "source_urls": {"type": "ARRAY", "items": {"type": "STRING"}, "maxItems": 5},
                                    "rationale": {"type": "STRING", "maxLength": 300},
                                },
                                "required": ["field", "value", "confidence", "source_urls", "rationale"],
                            },
                        }
                    },
                    "required": ["claims"],
                },
                "thinkingConfig": {"thinkingBudget": 0},
                "temperature": 0.1,
                "maxOutputTokens": 8192,
            },
        },
        timeout=45,
        attempts=1,
    )
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    parsed = json.loads(text)
    claims = parsed.get("claims") if isinstance(parsed, dict) else []
    allowed = set(allowed_urls)
    for claim in claims:
        claim["source_urls"] = [url for url in claim.get("source_urls", []) if url in allowed]
    return claims


def _fallback_claims(domain: str, evidence: list[dict[str, Any]]) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    official = next((item for item in evidence if item["source_type"] == "official_website"), None)
    github = next((item for item in evidence if item["source_type"] == "github_organization"), None)
    if official:
        title = str(official.get("title") or "").strip()
        name = re.split(r"\s+[|\-]\s+", title, maxsplit=1)[0] or domain.split(".")[0].title()
        claims.append({"field": "company_name", "value": name, "confidence": 0.86, "source_urls": [official["url"]], "rationale": "Official website title"})
        description = str(official.get("attributes", {}).get("description") or "").strip()
        if description:
            claims.append({"field": "summary", "value": description, "confidence": 0.78, "source_urls": [official["url"]], "rationale": "Official website metadata"})
    if github:
        attributes = github.get("attributes", {})
        if attributes.get("location"):
            claims.append({"field": "headquarters", "value": attributes["location"], "confidence": 0.58, "source_urls": [github["url"]], "rationale": "Public GitHub organization location; requires confirmation"})
        claims.append({"field": "signal", "value": f"Maintains {attributes.get('public_repos', 0)} public GitHub repositories", "confidence": 0.9, "source_urls": [github["url"]], "rationale": "GitHub organization metadata"})
    return claims


def inject_conflict(claims: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = json.loads(json.dumps(claims))
    target = next((claim for claim in output if claim["field"] in {"headquarters", "founded_year", "industry"}), None)
    if not target:
        target = {"field": "founded_year", "value": "2012", "confidence": 0.74, "source_urls": ["https://example.invalid/simulated-source"], "rationale": "Simulated provider claim", "status": "conflict", "alternatives": []}
        output.append(target)
    target["status"] = "conflict"
    target.setdefault("alternatives", []).append({"field": target["field"], "value": "Conflicting provider value", "confidence": 0.61, "source_urls": ["https://example.invalid/simulated-source"], "rationale": "Injected test evidence"})
    return output


def _norm(value: Any) -> str:
    return re.sub(r"\W+", "", str(value).lower())


def urllib_quote(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "", value)

