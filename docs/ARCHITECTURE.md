# Architecture

## Runtime Flow

```text
Browser
  -> Investigation API
     -> orchestration layer
        -> Firecrawl connector ----+
        -> Tavily connector -------+--> immutable evidence records
        -> GitHub connector -------+
        -> D1 corpus lookup ---------> company match + peer cohort
                                      -> constrained claim extraction
                                      -> deterministic ICP qualification
                                      -> deterministic conflict resolver
                                      -> quality metrics and claim ledger
                                      -> D1 run summary
  <- polling state, events, evidence, claims, and model status
```

## Data Contracts

Every connector returns the same envelope:

```json
{
  "provider": "tavily",
  "status": "success | no_match | error | not_configured",
  "duration_ms": 412,
  "records": [],
  "error": null,
  "cached": false
}
```

An HTTP response is not counted as populated success unless usable records were returned. Provider records are converted into evidence without overwriting one another. Claims reference exact evidence URLs and are rejected when their field is unsupported or their citation is absent.

ICP qualification consumes the public corpus record, supported claims, and immutable evidence. Geography and company-size checks are hard gates when known. Unknown values remain `unverified` and receive no score; they are never inferred by the model.

## Reliability Behavior

- Connectors execute concurrently, so one slow provider does not serialize the run.
- Network adapters use bounded retries, exponential backoff, and timeouts.
- Provider failures are data in the run result, not fatal pipeline exceptions.
- A deterministic extractor and answer path remain available when Gemini is unavailable.
- Completed runs are cached by normalized domain for six hours.
- Run files use temporary-file replacement so readers do not observe partial JSON.
- The hosted Worker persists compact run summaries in D1 and degrades visibly if storage is unavailable.
- Corpus initialization is idempotent and uses domain primary keys plus batched inserts.

## Trust Boundaries

- API keys are loaded into the server process and never returned to the browser.
- The domain validator rejects local, internal, malformed, and placeholder targets.
- AI-generated citations are intersected with the URLs collected in the active run.
- Playbook rules and weights are server-side constants, separate from model prompts and responses.
- Browser output is escaped before insertion, and outbound links allow only HTTP(S).
- The exported evidence package contains run data, not environment configuration.
- The public corpus builder uses a field allowlist; contact data and client-only scoring never enter the deploy artifact.

## Scaling Path

The local implementation keeps active run state in process. The hosted deployment uses D1 for the normalized public-company serving layer and compact run summaries. At higher volume, active orchestration would move to a queue, hot state to Redis, and complete immutable evidence packages to object storage. The provider, corpus, and claim contracts can remain unchanged.
