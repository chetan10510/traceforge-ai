# TraceForge AI

TraceForge is a recruiter-testable AI and data engineering project. Give it a public company domain and it runs a typed multi-provider pipeline, retains raw evidence, resolves supported claims, exposes contradictions, and answers questions only from the active claim ledger.

**Live demo:** [traceforge-ai.korivichetan5.chatgpt.site](https://traceforge-ai.korivichetan5.chatgpt.site)

It is an investigation tool, not a static dashboard. Try a domain, inspect each connector, inject a conflict, challenge the evidence, and export the full run as JSON.

## What It Demonstrates

- Parallel data ingestion from Firecrawl, Tavily, and GitHub
- A uniform provider contract with `success`, `no_match`, `error`, and `not_configured` states
- Evidence lineage from raw provider records to canonical claims
- Gemini extraction constrained to collected URLs, with deterministic fallback
- Conflict preservation rather than silent last-write-wins resolution
- Background execution, progress events, six-hour cache, and atomic run persistence
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

## API

```text
GET  /health
POST /api/investigations
GET  /api/investigations/{run_id}
POST /api/investigations/{run_id}/conflict
POST /api/investigations/{run_id}/ask
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for contracts, trust boundaries, and failure behavior.

## Responsible Use

TraceForge collects public company-level information. It intentionally does not enrich personal contact information, infer private attributes, or hide unsupported results behind generated prose.
