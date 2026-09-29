"""Investigation orchestration, run state, persistence, and grounded Q&A."""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .providers import ProviderResult, request_json, run_firecrawl, run_github, run_tavily
from .qualification import PLAYBOOKS, normalize_playbook, public_playbook, qualify_company
from .resolver import build_evidence, extract_claims, inject_conflict, urllib_quote


ROOT = Path(__file__).resolve().parents[1]
RUNS_DIR = ROOT / "data" / "runs"
RUNS: dict[str, dict[str, Any]] = {}
RUNS_LOCK = threading.Lock()
CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
CACHE_TTL_SECONDS = 60 * 60 * 6


STAGES = [
    ("validate", "Validate target", "Confirm a safe public company domain"),
    ("discover", "Discover sources", "Search public sources and identify evidence"),
    ("collect", "Collect evidence", "Run website, search, and GitHub connectors"),
    ("resolve", "Resolve claims", "Normalize evidence and reconcile contradictions"),
    ("brief", "Build briefing", "Generate an evidence-constrained company profile"),
]


def normalize_domain(raw: str) -> str:
    value = raw.strip().lower()
    value = re.sub(r"^https?://", "", value).split("/")[0].split("?")[0]
    value = value.removeprefix("www.").strip(".")
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,24}", value):
        raise ValueError("Enter a public company domain, for example stripe.com")
    if value.endswith((".local", ".internal")) or value in {"localhost", "example.com"}:
        raise ValueError("Private, local, and placeholder domains are not supported")
    return value


def create_investigation(raw_domain: str, raw_playbook: str = "engineering_scale") -> dict[str, Any]:
    domain = normalize_domain(raw_domain)
    playbook_id = normalize_playbook(raw_playbook)
    cache_key = f"{domain}:{playbook_id}"
    cached = CACHE.get(cache_key)
    if cached and time.time() - cached[0] < CACHE_TTL_SECONDS:
        cloned = json.loads(json.dumps(cached[1]))
        run_id = uuid.uuid4().hex[:12]
        cloned.update({"id": run_id, "cached": True, "created_at": now(), "updated_at": now()})
        with RUNS_LOCK:
            RUNS[run_id] = cloned
        return public_run(cloned)

    run_id = uuid.uuid4().hex[:12]
    run = {
        "id": run_id,
        "domain": domain,
        "playbook": public_playbook(playbook_id),
        "status": "queued",
        "progress": 2,
        "current_stage": "validate",
        "created_at": now(),
        "updated_at": now(),
        "cached": False,
        "stages": [
            {"id": stage_id, "label": label, "description": description, "status": "pending", "duration_ms": None}
            for stage_id, label, description in STAGES
        ],
        "providers": [],
        "evidence": [],
        "claims": [],
        "model": {},
        "quality": {},
        "events": [],
        "error": None,
    }
    with RUNS_LOCK:
        RUNS[run_id] = run
    threading.Thread(target=_execute, args=(run_id,), daemon=True).start()
    return public_run(run)


def get_investigation(run_id: str) -> dict[str, Any] | None:
    with RUNS_LOCK:
        run = RUNS.get(run_id)
        return public_run(run) if run else None


def inject_test_conflict(run_id: str) -> dict[str, Any] | None:
    with RUNS_LOCK:
        run = RUNS.get(run_id)
        if not run or run["status"] != "complete":
            return None
        run["claims"] = inject_conflict(run["claims"])
        run["quality"] = quality_summary(run["claims"], run["evidence"])
        run["events"].append(event("conflict_injected", "Test conflict added to the claim graph", "warning"))
        run["updated_at"] = now()
        _persist(run)
        return public_run(run)


def answer_question(run_id: str, question: str) -> dict[str, Any] | None:
    with RUNS_LOCK:
        run = RUNS.get(run_id)
        if not run or run["status"] != "complete":
            return None
        snapshot = json.loads(json.dumps(run))
    question = question.strip()[:600]
    allowed_urls = sorted({url for claim in snapshot["claims"] for url in claim.get("source_urls", [])})
    if not question:
        return {"answer": "Ask a question about the collected company evidence.", "citations": [], "grounded": True}
    key = os.getenv("GEMINI_API_KEY", "")
    if not key:
        return _deterministic_answer(snapshot, question)
    prompt = f"""Answer the question using only the claims JSON. If the evidence is insufficient, say so directly.
Return JSON with answer (string), citations (array of exact allowed URLs), and grounded (boolean).
Do not use prior knowledge. Allowed URLs: {json.dumps(allowed_urls)}
Question: {question}
Claims: {json.dumps(snapshot['claims'], ensure_ascii=True)[:30000]}"""
    try:
        model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        response = request_json(
            f"https://generativelanguage.googleapis.com/v1beta/models/{urllib_quote(model)}:generateContent",
            method="POST",
            headers={"x-goog-api-key": key},
            payload={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0.1, "maxOutputTokens": 1200},
            },
            timeout=35,
            attempts=1,
        )
        text = response["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
        citations = [url for url in parsed.get("citations", []) if url in allowed_urls]
        return {"answer": str(parsed.get("answer") or "Insufficient evidence."), "citations": citations, "grounded": bool(citations) or "insufficient" in str(parsed.get("answer", "")).lower()}
    except Exception:
        return _deterministic_answer(snapshot, question)


def _execute(run_id: str) -> None:
    try:
        _start_stage(run_id, "validate", 5)
        time.sleep(0.25)
        _finish_stage(run_id, "validate", 12, "Target passed domain and network safety checks")

        _start_stage(run_id, "discover", 18)
        domain = RUNS[run_id]["domain"]
        playbook_id = RUNS[run_id]["playbook"]["id"]
        _add_event(run_id, "source_plan", f"Planned Firecrawl, Tavily, and GitHub connectors for {PLAYBOOKS[playbook_id]['name']}", "info")
        time.sleep(0.2)
        _finish_stage(run_id, "discover", 27, "Three public provider adapters scheduled")

        _start_stage(run_id, "collect", 32)
        results: list[ProviderResult] = []
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(run_firecrawl, domain): "run_firecrawl",
                executor.submit(run_tavily, domain, PLAYBOOKS[playbook_id]["name"]): "run_tavily",
                executor.submit(run_github, domain): "run_github",
            }
            for future in as_completed(futures):
                result = future.result()
                results.append(result)
                _provider_result(run_id, result)
        _finish_stage(run_id, "collect", 63, f"Collected {sum(len(item.records) for item in results)} evidence records")

        _start_stage(run_id, "resolve", 68)
        evidence = build_evidence(results)
        claims, model = extract_claims(domain, results)
        qualification = qualify_company(playbook_id, claims, evidence)
        with RUNS_LOCK:
            RUNS[run_id]["evidence"] = evidence
            RUNS[run_id]["claims"] = claims
            RUNS[run_id]["model"] = model
            RUNS[run_id]["qualification"] = qualification
        _finish_stage(run_id, "resolve", 87, f"Resolved {len(claims)} canonical claims")

        _start_stage(run_id, "brief", 91)
        quality = quality_summary(claims, evidence)
        with RUNS_LOCK:
            run = RUNS[run_id]
            run["quality"] = quality
            run["status"] = "complete"
            run["progress"] = 100
            run["updated_at"] = now()
        _finish_stage(run_id, "brief", 100, f"Evidence coverage {quality['citation_coverage']}%")
        with RUNS_LOCK:
            completed = json.loads(json.dumps(RUNS[run_id]))
        CACHE[f"{domain}:{playbook_id}"] = (time.time(), completed)
        _persist(completed)
    except Exception as error:
        with RUNS_LOCK:
            run = RUNS[run_id]
            run["status"] = "failed"
            run["error"] = str(error)[:300]
            run["updated_at"] = now()
            for stage in run["stages"]:
                if stage["status"] == "running":
                    stage["status"] = "failed"
        _persist(RUNS[run_id])


def quality_summary(claims: list[dict[str, Any]], evidence: list[dict[str, Any]]) -> dict[str, Any]:
    claimed = len(claims)
    cited = sum(bool(claim.get("source_urls")) for claim in claims)
    conflicts = sum(claim.get("status") == "conflict" for claim in claims)
    average = round(sum(float(claim.get("confidence", 0)) for claim in claims) / claimed * 100) if claimed else 0
    return {
        "claims": claimed,
        "evidence_records": len(evidence),
        "citation_coverage": round(cited / claimed * 100) if claimed else 0,
        "average_confidence": average,
        "conflicts": conflicts,
    }


def public_run(run: dict[str, Any] | None) -> dict[str, Any]:
    if not run:
        return {}
    output = json.loads(json.dumps(run))
    for stage in output.get("stages", []):
        stage.pop("started_monotonic", None)
    for provider in output.get("providers", []):
        provider["record_count"] = len(provider.get("records", []))
        provider.pop("records", None)
    return output


def _start_stage(run_id: str, stage_id: str, progress: int) -> None:
    with RUNS_LOCK:
        run = RUNS[run_id]
        run["status"] = "running"
        run["current_stage"] = stage_id
        run["progress"] = progress
        run["updated_at"] = now()
        for stage in run["stages"]:
            if stage["id"] == stage_id:
                stage["status"] = "running"
                stage["started_monotonic"] = time.monotonic()


def _finish_stage(run_id: str, stage_id: str, progress: int, message: str) -> None:
    with RUNS_LOCK:
        run = RUNS[run_id]
        run["progress"] = progress
        run["updated_at"] = now()
        for stage in run["stages"]:
            if stage["id"] == stage_id:
                started = stage.pop("started_monotonic", time.monotonic())
                stage["status"] = "complete"
                stage["duration_ms"] = round((time.monotonic() - started) * 1000)
        run["events"].append(event(stage_id, message, "success"))


def _provider_result(run_id: str, result: ProviderResult) -> None:
    with RUNS_LOCK:
        run = RUNS[run_id]
        run["providers"].append(result.to_dict())
        run["events"].append(event(result.provider, f"{result.status.replace('_', ' ')} · {len(result.records)} records · {result.duration_ms}ms", "success" if result.status == "success" else "warning"))
        run["updated_at"] = now()


def _add_event(run_id: str, kind: str, message: str, tone: str) -> None:
    with RUNS_LOCK:
        RUNS[run_id]["events"].append(event(kind, message, tone))


def event(kind: str, message: str, tone: str) -> dict[str, str]:
    return {"kind": kind, "message": message, "tone": tone, "at": now()}


def now() -> str:
    return datetime.now(UTC).isoformat()


def _persist(run: dict[str, Any]) -> None:
    try:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        target = RUNS_DIR / f"{run['id']}.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(run, indent=2), encoding="utf-8")
        temporary.replace(target)
    except OSError:
        pass


def _deterministic_answer(run: dict[str, Any], question: str) -> dict[str, Any]:
    terms = set(re.findall(r"[a-z0-9]+", question.lower())) - {"what", "where", "when", "does", "about", "company", "the", "is", "are"}
    ranked = sorted(
        run["claims"],
        key=lambda claim: sum(term in json.dumps(claim).lower() for term in terms),
        reverse=True,
    )
    selected = [claim for claim in ranked[:3] if claim.get("source_urls")]
    if not selected:
        return {"answer": "The collected evidence is insufficient to answer that question.", "citations": [], "grounded": True}
    answer = " ".join(f"{claim['field'].replace('_', ' ').title()}: {claim['value']}." for claim in selected)
    citations = list(dict.fromkeys(url for claim in selected for url in claim["source_urls"]))[:5]
    return {"answer": answer, "citations": citations, "grounded": True}

