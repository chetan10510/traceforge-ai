# Architecture

## Runtime Flow

```text
Browser
  -> Investigation API
     -> background orchestrator
        -> Firecrawl connector ----+
        -> Tavily connector -------+--> immutable evidence records
        -> GitHub connector -------+
                                      -> constrained claim extraction
                                      -> deterministic conflict resolver
                                      -> quality metrics and claim ledger
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

## Reliability Behavior

- Connectors execute concurrently, so one slow provider does not serialize the run.
- Network adapters use bounded retries, exponential backoff, and timeouts.
- Provider failures are data in the run result, not fatal pipeline exceptions.
- A deterministic extractor and answer path remain available when Gemini is unavailable.
- Completed runs are cached by normalized domain for six hours.
- Run files use temporary-file replacement so readers do not observe partial JSON.

## Trust Boundaries

- API keys are loaded into the server process and never returned to the browser.
- The domain validator rejects local, internal, malformed, and placeholder targets.
- AI-generated citations are intersected with the URLs collected in the active run.
- Browser output is escaped before insertion, and outbound links allow only HTTP(S).
- The exported evidence package contains run data, not environment configuration.

## Scaling Path

The local implementation keeps run state in process so the portfolio demo has no paid infrastructure dependency. A production deployment would replace the thread with a queue worker, the in-memory map with Redis, JSON persistence with object storage or Postgres, and local rate behavior with shared provider budgets. The provider and claim contracts can remain unchanged.
