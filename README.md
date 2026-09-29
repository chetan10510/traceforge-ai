# TraceForge AI

TraceForge is a recruiter-testable AI and data engineering project. Give it a public company domain and it runs a typed multi-provider pipeline, retains raw evidence, joins the target to a normalized public-company corpus, resolves supported claims, exposes contradictions, and answers questions only from the active claim ledger.

**Live demo:** [traceforge-ai.korivichetan5.chatgpt.site](https://traceforge-ai.korivichetan5.chatgpt.site)

It is an investigation tool, not a static dashboard. Try a domain, inspect each connector, inject a conflict, challenge the evidence, and export the full run as JSON.

## 90-Second Recruiter Test

1. Open the live demo and investigate `stripe.com`, `resend.com`, or a company you know.
2. Try `resend.com` or `infisical.com` to inspect the D1 corpus match, provenance, and peer cohort.
3. Inspect connector latency and distinguish populated success from provider error or no-match.
4. Open claim citations, then inject a conflict and watch the quality metrics change.
5. Ask a question the evidence can answer, followed by one it cannot, then export the evidence package.

## What It Demonstrates

- Parallel data ingestion from Firecrawl, Tavily, and GitHub
- A uniform provider contract with `success`, `no_match`, `error`, and `not_configured` states
- Evidence lineage from raw provider records to canonical claims
- Gemini extraction constrained to collected URLs, with deterministic fallback
- Conflict preservation rather than silent last-write-wins resolution
- A reproducible allowlist ETL that strips person and client-only fields before publication
- D1-backed company lookup, cohort retrieval, and durable investigation summaries
- A dependency-free Python API, responsive frontend, tests, health check, and container build
- A Cloudflare Worker deployment adapter with encrypted server-side provider configuration

## Run Locally

Create `.env` from `.env.example`, then add any provider keys you want to use. Missing providers remain visible in the interface and do not prevent a run.

```powershell
cd D:\ICUSTOMER.AI\traceforge-ai
Copy-Item .env.example .env
py -3 -m backend.server 8090
```

Open [http://localhost:8090](http://localhost:8090). TraceForge also discovers a `.env` file in the parent directory, which is useful for local development.

## Test

```powershell
py -3 -m unittest discover -s tests -v
```

On Linux or WSL, replace `py -3` with `python3`.

## Environment

| Variable | Purpose | Required |
| --- | --- | --- |
| `FIRECRAWL_API_KEY` | Official website scrape | No |
| `TAVILY_API_KEY` | Public web discovery | No |
| `GITHUB_TOKEN` | Higher GitHub API rate limits | No |
| `GEMINI_API_KEY` | Evidence-constrained extraction and Q&A | No |
| `GEMINI_MODEL` | Gemini model ID; defaults to `gemini-2.5-flash` | No |

Secrets are server-side only and are excluded from exports and API responses.

## Runtime Targets

`backend/` provides the dependency-free Python development and container runtime. `worker/` provides the production serverless adapter used by the live portfolio deployment. Both expose the same browser-facing API contract and evidence rules.

## Integration Decisions

| Component | Why it exists | Visible failure behavior |
| --- | --- | --- |
| Firecrawl | Captures first-party website evidence | `no_match` or `error`; no synthetic homepage data |
| Tavily | Discovers independent public sources | Search records remain separate and individually cited |
| GitHub | Adds a public engineering signal | API quota falls back to a verifiable public organization page |
| Gemini | Converts evidence into a strict claim schema | Malformed or unavailable output uses deterministic extraction |

This is an interactive, low-volume investigation workload, so Kafka and Spark would add operational theater rather than useful capability. D1 provides the relational serving layer and run warehouse; the scaling path is queue workers for long jobs and object storage for full raw evidence. That boundary is intentional and testable.

## Public Corpus

The hosted seed contains 2,198 domain-keyed company records derived from the public Y Combinator directory export already present in the data workspace. `scripts/build_public_corpus.py` is the reproducible privacy boundary: it keeps an explicit company-level allowlist and excludes emails, phone numbers, people, LinkedIn profiles, internal fit scores, and client segmentation labels.

The deployed Worker exposes an idempotent `POST /api/corpus/seed` initializer. It creates the D1 schema, inserts any missing records, and can safely resume after an interrupted batch. `GET /api/corpus/stats` reports the populated record count.

## API

```text
GET  /health
GET  /api/corpus/stats
POST /api/corpus/seed
POST /api/investigations
GET  /api/investigations/{run_id}
POST /api/investigations/{run_id}/conflict
POST /api/investigations/{run_id}/ask
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for contracts, trust boundaries, and failure behavior.

## Responsible Use

TraceForge collects public company-level information. It intentionally does not publish ASA, Hirebooth, OneSource, or SIX client/contact exports; enrich personal contact information; infer private attributes; or hide unsupported results behind generated prose.
