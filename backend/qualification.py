"""Deterministic ICP qualification kept separate from AI claim extraction."""

from __future__ import annotations

import json
from typing import Any


PLAYBOOKS = {
    "regulated_ai": {
        "name": "Regulated AI & Security",
        "geography": ("united states", "usa", "canada", "north america"),
        "size": (50, 2000),
        "industries": ("healthcare", "health care", "financial", "bank", "insurance", "legal", "government", "public sector", "compliance"),
        "signals": ("artificial intelligence", " ai ", "machine learning", "security", "compliance", "privacy", "governance", "risk"),
    },
    "support_scale": {
        "name": "Customer Support Scale",
        "geography": ("united states", "usa"),
        "size": (50, 500),
        "industries": ("saas", "software", "fintech", "healthtech", "healthcare", "logistics", "e-commerce", "ecommerce"),
        "signals": ("customer support", "customer success", "support role", "hiring", "careers", "funding", "growth", "offshore"),
    },
    "engineering_scale": {
        "name": "Engineering Scale",
        "geography": ("united states", "usa"),
        "size": (30, 300),
        "industries": ("saas", "software", "developer", "fintech", "b2b", "digital product", "technology"),
        "signals": ("engineering", "developer", "github", "python", "javascript", "java", "aws", "devops", "remote", "hiring", "scaling"),
    },
    "growth_markets": {
        "name": "Growth Market Segments",
        "geography": (),
        "size": (10, 1000),
        "industries": ("saas", "software", "technology", "manufacturing", "construction", "industrial", "services", "logistics", "advisory"),
        "signals": ("growth", "funding", "hiring", "expansion", "platform", "digital", "automation"),
    },
}


def normalize_playbook(value: str) -> str:
    playbook_id = (value or "engineering_scale").strip().lower()
    if playbook_id not in PLAYBOOKS:
        raise ValueError("Choose a supported ICP playbook")
    return playbook_id


def public_playbook(playbook_id: str) -> dict[str, str]:
    return {"id": playbook_id, "name": PLAYBOOKS[playbook_id]["name"], "source": "Generalized production ICP pattern"}


def qualify_company(playbook_id: str, claims: list[dict[str, Any]], evidence: list[dict[str, Any]]) -> dict[str, Any]:
    playbook = PLAYBOOKS[playbook_id]
    text = " " + " ".join(
        [json.dumps(claim, ensure_ascii=True) for claim in claims]
        + [f"{item.get('title', '')} {item.get('content', '')}" for item in evidence]
    ).lower() + " "
    criteria = []

    if playbook["geography"]:
        matched = _contains(text, playbook["geography"])
        known = any(claim.get("field") == "headquarters" for claim in claims)
        criteria.append(_criterion("geography", "Target geography", 20, "met" if matched else "not_met" if known else "unverified", "Matched target geography" if matched else "No defensible target-geography evidence collected", _sources(playbook["geography"], claims, evidence), True))

    low, high = playbook["size"]
    criteria.append(_criterion("company_size", "Company size", 20, "unverified", f"Employee count unavailable locally; target is {low}-{high}", [], True))
    industry_weight = 30 if playbook["geography"] else 45
    industry_match = _contains(text, playbook["industries"])
    criteria.append(_criterion("industry", "Industry fit", industry_weight, "met" if industry_match else "unverified", "Matched playbook industry evidence" if industry_match else "No target-industry phrase was supported", _sources(playbook["industries"], claims, evidence), False))
    signal_weight = 30 if playbook["geography"] else 35
    signal_match = _contains(text, playbook["signals"])
    criteria.append(_criterion("buying_signals", "Buying and operating signals", signal_weight, "met" if signal_match else "unverified", "Matched at least one playbook signal" if signal_match else "No qualifying signal was confirmed", _sources(playbook["signals"], claims, evidence), False))

    total = sum(item["weight"] for item in criteria)
    score = round(sum(item["score"] for item in criteria) / total * 100)
    coverage = round(sum(item["weight"] for item in criteria if item["status"] != "unverified") / total * 100)
    hard_failure = any(item["hard_gate"] and item["status"] == "not_met" for item in criteria)
    verdict = "Exclude" if hard_failure else "Strong Fit" if score >= 75 and coverage >= 70 else "Likely Fit" if score >= 50 else "Review"
    return {"playbook_id": playbook_id, "playbook_name": playbook["name"], "verdict": verdict, "score": score, "coverage": coverage, "criteria": criteria, "methodology": "Deterministic weighted rules over source-linked company evidence; unknown values remain unverified"}


def _criterion(identifier: str, label: str, weight: int, status: str, reason: str, urls: list[str], hard_gate: bool) -> dict[str, Any]:
    return {"id": identifier, "label": label, "weight": weight, "status": status, "reason": reason, "hard_gate": hard_gate, "score": weight if status == "met" else 0, "source_urls": list(dict.fromkeys(urls))[:4]}


def _contains(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)


def _sources(terms: tuple[str, ...], claims: list[dict[str, Any]], evidence: list[dict[str, Any]]) -> list[str]:
    urls = []
    for claim in claims:
        if _contains(json.dumps(claim, ensure_ascii=True).lower(), terms):
            urls.extend(claim.get("source_urls") or [])
    for item in evidence:
        if _contains(f"{item.get('title', '')} {item.get('content', '')}".lower(), terms) and str(item.get("url", "")).startswith(("http://", "https://")):
            urls.append(item["url"])
    return urls
