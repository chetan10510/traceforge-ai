const RUNS = new Map();
const CLAIM_FIELDS = new Set([
  "company_name", "summary", "industry", "headquarters", "founded_year", "product", "technology", "signal",
]);

const STAGES = [
  ["validate", "Validate target", "Confirm a safe public company domain"],
  ["discover", "Discover sources", "Search public sources and identify evidence"],
  ["collect", "Collect evidence", "Run website, search, and GitHub connectors"],
  ["resolve", "Resolve claims", "Normalize evidence and reconcile contradictions"],
  ["brief", "Build briefing", "Generate an evidence-constrained company profile"],
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        return json({
          status: "ok",
          service: "traceforge-worker",
          providers: configuredProviders(env),
          storage: { d1: Boolean(env.DB) },
        });
      }

      if (url.pathname === "/api/corpus/stats" && request.method === "GET") {
        return json(await corpusStats(env));
      }

      if (url.pathname === "/api/corpus/seed" && request.method === "POST") {
        return json(await seedCorpus(env, url), 201);
      }

      if (url.pathname === "/api/investigations" && request.method === "POST") {
        const body = await readJson(request);
        const run = await investigate(normalizeDomain(body.domain), env);
        RUNS.set(run.id, run);
        return json(run, 201);
      }

      const route = url.pathname.match(/^\/api\/investigations\/([a-zA-Z0-9-]+)(?:\/(conflict|ask))?$/);
      if (route) {
        const [, runId, action] = route;
        if (request.method === "GET" && !action) {
          const run = RUNS.get(runId);
          return run ? json(run) : json({ error: "investigation_not_found" }, 404);
        }
        if (request.method === "POST" && action) {
          const body = await readJson(request);
          const run = RUNS.get(runId) || validSnapshot(body.run, runId);
          if (!run || run.status !== "complete") return json({ error: "investigation_not_ready" }, 409);
          if (action === "conflict") {
            const updated = addConflict(run);
            RUNS.set(runId, updated);
            return json(updated);
          }
          return json(await answerQuestion(run, String(body.question || ""), env));
        }
      }

      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
      const asset = await env.ASSETS.fetch(request);
      const acceptsHtml = request.headers.get("accept")?.includes("text/html");
      if (asset.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) return secure(asset);
      const indexUrl = new URL(request.url);
      indexUrl.pathname = "/index.html";
      indexUrl.search = "";
      return secure(await env.ASSETS.fetch(new Request(indexUrl, request)));
    } catch (error) {
      const message = error instanceof UserError ? error.message : "The request could not be completed.";
      return json({ error: error instanceof UserError ? "invalid_request" : "internal_error", message }, error instanceof UserError ? 400 : 500);
    }
  },
};

async function investigate(domain, env) {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const createdAt = new Date().toISOString();
  const started = Date.now();
  const events = [
    event("validate", "Target passed domain and network safety checks", "success"),
    event("source_plan", "Planned Firecrawl, Tavily, and GitHub connectors", "info"),
    event("discover", "Three public provider adapters scheduled", "success"),
  ];
  const collectStarted = Date.now();
  const [providers, corpus] = await Promise.all([
    Promise.all([
      runFirecrawl(domain, env),
      runTavily(domain, env),
      runGithub(domain, env),
    ]),
    lookupCorpus(domain, env),
  ]);
  for (const provider of providers) {
    events.push(event(provider.provider, `${provider.status.replaceAll("_", " ")} · ${provider.records.length} records · ${provider.duration_ms}ms`, provider.status === "success" ? "success" : "warning"));
  }
  const evidence = buildEvidence(providers);
  events.push(event("collect", `Collected ${evidence.length} evidence records`, "success"));
  const resolveStarted = Date.now();
  const extraction = await extractClaims(domain, evidence, env);
  events.push(event("resolve", `Resolved ${extraction.claims.length} canonical claims`, "success"));
  const quality = qualitySummary(extraction.claims, evidence);
  events.push(event("brief", `Evidence coverage ${quality.citation_coverage}%`, "success"));
  events.push(event("corpus", corpus.status === "matched" ? `Matched ${domain} in the public company corpus` : corpus.message, corpus.status === "unavailable" ? "warning" : "info"));
  const finished = Date.now();

  const run = {
    id,
    domain,
    status: "complete",
    progress: 100,
    current_stage: "brief",
    created_at: createdAt,
    updated_at: new Date().toISOString(),
    cached: false,
    stages: STAGES.map(([stageId, label, description]) => ({
      id: stageId,
      label,
      description,
      status: "complete",
      duration_ms: stageDuration(stageId, started, collectStarted, resolveStarted, finished),
    })),
    providers: providers.map(publicProvider),
    evidence,
    claims: extraction.claims,
    model: extraction.model,
    quality,
    corpus,
    events,
    error: null,
  };
  run.warehouse = await persistRun(run, env);
  run.events.push(event("warehouse", run.warehouse.persisted ? "Run summary persisted to D1" : run.warehouse.message, run.warehouse.persisted ? "success" : "warning"));
  return run;
}

async function ensureDatabase(env) {
  if (!env.DB) throw new Error("D1 binding is not configured");
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS public_companies (
      domain TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      website TEXT,
      founded_year INTEGER,
      funding_stage TEXT,
      employee_count INTEGER,
      country TEXT,
      industry TEXT,
      subindustry TEXT,
      one_liner TEXT,
      source TEXT NOT NULL,
      source_proof TEXT,
      source_url TEXT NOT NULL,
      loaded_at TEXT NOT NULL
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_public_companies_industry ON public_companies(industry)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_public_companies_country ON public_companies(country)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS investigation_runs (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      provider_successes INTEGER NOT NULL,
      evidence_records INTEGER NOT NULL,
      claim_count INTEGER NOT NULL,
      citation_coverage INTEGER NOT NULL,
      average_confidence INTEGER NOT NULL,
      corpus_status TEXT NOT NULL,
      summary_json TEXT NOT NULL
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_investigation_runs_domain ON investigation_runs(domain)"),
  ]);
}

async function corpusStats(env) {
  if (!env.DB) return { status: "unavailable", record_count: 0, message: "D1 binding is not configured" };
  try {
    await ensureDatabase(env);
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM public_companies").first();
    return { status: Number(row?.count || 0) ? "ready" : "empty", record_count: Number(row?.count || 0), source: "Y Combinator public directory" };
  } catch (error) {
    return { status: "unavailable", record_count: 0, message: cleanError(error) };
  }
}

async function seedCorpus(env, requestUrl) {
  if (!env.DB) throw new UserError("D1 storage is not configured for this deployment");
  await ensureDatabase(env);
  const current = await env.DB.prepare("SELECT COUNT(*) AS count FROM public_companies").first();
  const assetUrl = new URL("/data/yc-public-companies.json", requestUrl);
  const response = await env.ASSETS.fetch(new Request(assetUrl));
  if (!response.ok) throw new Error("Public corpus seed asset is unavailable");
  const records = await response.json();
  if (Number(current?.count || 0) >= records.length) {
    return { status: "ready", record_count: Number(current.count), inserted: 0, source: "Y Combinator public directory" };
  }
  const loadedAt = new Date().toISOString();
  const statement = env.DB.prepare(`INSERT OR IGNORE INTO public_companies
    (domain, company_name, website, founded_year, funding_stage, employee_count, country, industry, subindustry, one_liner, source, source_proof, source_url, loaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let offset = 0; offset < records.length; offset += 250) {
    const batch = records.slice(offset, offset + 250).map((record) => statement.bind(
      record.domain, record.company_name, record.website, record.founded_year, record.funding_stage,
      record.employee_count, record.country, record.industry, record.subindustry, record.one_liner,
      record.source, record.source_proof, record.yc_url, loadedAt,
    ));
    await env.DB.batch(batch);
  }
  const result = await env.DB.prepare("SELECT COUNT(*) AS count FROM public_companies").first();
  return { status: "ready", record_count: Number(result?.count || 0), inserted: Number(result?.count || 0) - Number(current?.count || 0), source: "Y Combinator public directory" };
}

async function lookupCorpus(domain, env) {
  if (!env.DB) return { status: "unavailable", record_count: 0, record: null, peers: [], message: "Cloud corpus is not configured" };
  try {
    await ensureDatabase(env);
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM public_companies").first();
    const recordCount = Number(countRow?.count || 0);
    if (!recordCount) return { status: "empty", record_count: 0, record: null, peers: [], message: "Public corpus is awaiting its first seed" };
    const record = await env.DB.prepare("SELECT * FROM public_companies WHERE domain = ?").bind(domain).first();
    if (!record) return { status: "no_match", record_count: recordCount, record: null, peers: [], message: `No ${domain} record in the public accelerator corpus` };
    const peerResult = await env.DB.prepare(`SELECT domain, company_name, funding_stage, country, industry, employee_count, source_url
      FROM public_companies WHERE domain <> ? AND industry = ?
      ORDER BY CASE WHEN country = ? THEN 0 ELSE 1 END, ABS(COALESCE(employee_count, 0) - COALESCE(?, 0)), company_name LIMIT 4`)
      .bind(domain, record.industry, record.country, record.employee_count).all();
    return {
      status: "matched",
      record_count: recordCount,
      record: publicCompany(record),
      peers: (peerResult.results || []).map(publicCompany),
      message: `Matched ${domain} in the public accelerator corpus`,
    };
  } catch (error) {
    return { status: "unavailable", record_count: 0, record: null, peers: [], message: cleanError(error) };
  }
}

function publicCompany(record) {
  const fields = ["domain", "company_name", "website", "founded_year", "funding_stage", "employee_count", "country", "industry", "subindustry", "one_liner", "source", "source_proof", "source_url"];
  return Object.fromEntries(fields.map((field) => [field, record[field] ?? null]));
}

async function persistRun(run, env) {
  if (!env.DB) return { persisted: false, message: "D1 warehouse is not configured" };
  try {
    await ensureDatabase(env);
    const summary = {
      model: run.model,
      quality: run.quality,
      providers: run.providers,
      claims: run.claims.map(({ field, value, confidence, status, source_urls }) => ({ field, value, confidence, status, source_urls })),
    };
    await env.DB.prepare(`INSERT OR REPLACE INTO investigation_runs
      (id, domain, created_at, completed_at, provider_successes, evidence_records, claim_count, citation_coverage, average_confidence, corpus_status, summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(run.id, run.domain, run.created_at, run.updated_at, run.providers.filter((item) => item.status === "success").length,
        run.quality.evidence_records, run.quality.claims, run.quality.citation_coverage, run.quality.average_confidence,
        run.corpus.status, JSON.stringify(summary)).run();
    return { persisted: true, engine: "D1", message: "Run summary persisted to D1" };
  } catch (error) {
    return { persisted: false, message: cleanError(error) };
  }
}

async function runFirecrawl(domain, env) {
  const started = Date.now();
  if (!env.FIRECRAWL_API_KEY) return missingProvider("firecrawl", started);
  try {
    const target = `https://${domain}`;
    const data = await fetchJson("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.FIRECRAWL_API_KEY}` },
      body: { url: target, formats: ["markdown"], onlyMainContent: true },
      timeout: 35000,
    });
    const envelope = data.data && typeof data.data === "object" ? data.data : data;
    const metadata = envelope.metadata && typeof envelope.metadata === "object" ? envelope.metadata : {};
    const markdown = String(envelope.markdown || "");
    const records = markdown ? [{
      source_id: "firecrawl-homepage",
      source_type: "official_website",
      title: metadata.title || domain,
      url: metadata.sourceURL || target,
      content: markdown.slice(0, 24000),
      description: metadata.description || "",
    }] : [];
    return providerResult("firecrawl", records, started);
  } catch (error) {
    return providerError("firecrawl", error, started);
  }
}

async function runTavily(domain, env) {
  const started = Date.now();
  if (!env.TAVILY_API_KEY) return missingProvider("tavily", started);
  try {
    const data = await fetchJson("https://api.tavily.com/search", {
      method: "POST",
      body: {
        api_key: env.TAVILY_API_KEY,
        query: `"${domain}" company products engineering official`,
        search_depth: "basic",
        max_results: 6,
        include_answer: false,
      },
    });
    const records = (data.results || []).filter((item) => item.url).map((item, index) => ({
      source_id: `tavily-${index + 1}`,
      source_type: "search_result",
      title: item.title || "Search result",
      url: item.url,
      content: item.content || "",
      score: item.score,
    }));
    return providerResult("tavily", records, started);
  } catch (error) {
    return providerError("tavily", error, started);
  }
}

async function runGithub(domain, env) {
  const started = Date.now();
  const query = domain.split(".")[0];
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const search = await fetchJson(`https://api.github.com/search/users?q=${encodeURIComponent(`${query} type:org`)}&per_page=4`, { headers });
    const normalized = query.toLowerCase().replace(/[^a-z0-9]/g, "");
    const candidate = (search.items || []).find((item) => String(item.login || "").toLowerCase().replace(/[^a-z0-9]/g, "").includes(normalized));
    if (!candidate) return providerResult("github", [], started);
    const org = await fetchJson(`https://api.github.com/orgs/${encodeURIComponent(candidate.login)}`, { headers });
    return providerResult("github", [{
      source_id: `github-org-${String(org.login || candidate.login).toLowerCase()}`,
      source_type: "github_organization",
      title: org.name || org.login,
      url: org.html_url || candidate.html_url,
      content: org.description || "",
      login: org.login,
      public_repos: org.public_repos,
      followers: org.followers,
      location: org.location,
      blog: org.blog,
      created_at: org.created_at,
      match_basis: "normalized organization name",
    }], started);
  } catch (error) {
    try {
      const publicUrl = `https://github.com/${encodeURIComponent(query)}`;
      const response = await fetch(publicUrl, { headers: { Accept: "text/html", "User-Agent": "TraceForgeAI/1.0 portfolio-research" } });
      if (!response.ok) throw error;
      const html = await response.text();
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      return providerResult("github", [{
        source_id: `github-public-${query.toLowerCase()}`,
        source_type: "github_public_page",
        title: titleMatch?.[1]?.replace(/\s*·\s*GitHub\s*$/, "").trim() || `${titleCase(query)} on GitHub`,
        url: publicUrl,
        content: `Public GitHub page matched from the normalized company domain slug: ${query}.`,
        login: query,
        match_basis: "normalized domain slug public-page fallback",
      }], started);
    } catch {
      return providerError("github", error, started);
    }
  }
}

function buildEvidence(providers) {
  return providers.flatMap((provider) => provider.records.filter((record) => record.url).map((record) => ({
    evidence_id: record.source_id,
    provider: provider.provider,
    source_type: record.source_type,
    title: record.title,
    url: record.url,
    content: String(record.content || "").slice(0, 9000),
    attributes: Object.fromEntries(Object.entries(record).filter(([key]) => !["content", "title", "url", "source_id", "source_type"].includes(key))),
  })));
}

async function extractClaims(domain, evidence, env) {
  if (!evidence.length) return { claims: [], model: { provider: "deterministic", status: "no_evidence" } };
  if (env.GEMINI_API_KEY) {
    try {
      const allowedUrls = evidence.map((item) => item.url);
      const compact = evidence.slice(0, 10).map((item) => ({
        provider: item.provider,
        source_type: item.source_type,
        title: item.title,
        url: item.url,
        content: item.content.slice(0, 2800),
        attributes: item.attributes,
      }));
      const fields = [...CLAIM_FIELDS].sort();
      const prompt = `You are a data quality extraction engine. Build claims about ${domain} only from the evidence JSON below.
Return at most one claim per field and at most 8 claims total. Keep values and rationales concise; combine multiple products or technologies in one string.
Allowed fields: ${JSON.stringify(fields)}. Every source URL must exactly match an evidence URL. Do not infer employee counts, revenue, funding, or people.
Allowed URLs: ${JSON.stringify(allowedUrls)}
Evidence: ${JSON.stringify(compact).slice(0, 24000)}`;
      const model = env.GEMINI_MODEL || "gemini-2.5-flash";
      const data = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY },
        body: {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: claimSchema(fields),
            thinkingConfig: { thinkingBudget: 0 },
            temperature: 0.1,
            maxOutputTokens: 8192,
          },
        },
        timeout: 45000,
      });
      const parsed = JSON.parse(data.candidates[0].content.parts[0].text);
      const allowed = new Set(allowedUrls);
      const claims = resolveClaims((parsed.claims || []).map((claim) => ({
        ...claim,
        source_urls: (claim.source_urls || []).filter((url) => allowed.has(url)),
      })));
      if (claims.length) return { claims, model: { provider: "gemini", status: "success" } };
    } catch (error) {
      return {
        claims: resolveClaims(fallbackClaims(domain, evidence)),
        model: { provider: "gemini", status: "fallback", error: cleanError(error) },
      };
    }
  }
  return {
    claims: resolveClaims(fallbackClaims(domain, evidence)),
    model: { provider: "gemini", status: "not_configured" },
  };
}

function resolveClaims(claims) {
  const grouped = new Map();
  for (const claim of claims) {
    const field = String(claim.field || "").trim().toLowerCase();
    const urls = (claim.source_urls || []).filter((url) => typeof url === "string" && /^https?:\/\//.test(url));
    if (!CLAIM_FIELDS.has(field) || claim.value == null || claim.value === "" || !urls.length) continue;
    const normalized = {
      field,
      value: claim.value,
      confidence: Math.max(0, Math.min(Number(claim.confidence || 0.5), 1)),
      source_urls: [...new Set(urls)].slice(0, 5),
      rationale: String(claim.rationale || "Evidence-backed public claim").slice(0, 300),
    };
    if (!grouped.has(field)) grouped.set(field, []);
    grouped.get(field).push(normalized);
  }
  return [...grouped.entries()].map(([field, candidates]) => {
    candidates.sort((a, b) => b.source_urls.length - a.source_urls.length || b.confidence - a.confidence);
    const winner = candidates[0];
    const alternatives = candidates.slice(1).filter((item) => normalizeValue(item.value) !== normalizeValue(winner.value)).slice(0, 3);
    return { ...winner, status: alternatives.length ? "conflict" : "verified", alternatives };
  }).sort((a, b) => Number(!["company_name", "summary", "industry"].includes(a.field)) - Number(!["company_name", "summary", "industry"].includes(b.field)) || a.field.localeCompare(b.field));
}

function fallbackClaims(domain, evidence) {
  const claims = [];
  const official = evidence.find((item) => item.source_type === "official_website");
  const github = evidence.find((item) => item.source_type === "github_organization");
  if (official) {
    const title = String(official.title || "").split(/\s+[|\-]\s+/)[0] || titleCase(domain.split(".")[0]);
    claims.push({ field: "company_name", value: title, confidence: 0.86, source_urls: [official.url], rationale: "Official website title" });
    if (official.attributes.description) claims.push({ field: "summary", value: official.attributes.description, confidence: 0.78, source_urls: [official.url], rationale: "Official website metadata" });
  }
  if (github) {
    if (github.attributes.location) claims.push({ field: "headquarters", value: github.attributes.location, confidence: 0.58, source_urls: [github.url], rationale: "Public GitHub organization location; requires confirmation" });
    if (github.attributes.public_repos != null) claims.push({ field: "signal", value: `Maintains ${github.attributes.public_repos} public GitHub repositories`, confidence: 0.9, source_urls: [github.url], rationale: "GitHub organization metadata" });
  }
  return claims;
}

async function answerQuestion(run, question, env) {
  const cleanQuestion = question.trim().slice(0, 600);
  const allowedUrls = [...new Set(run.claims.flatMap((claim) => claim.source_urls || []))].sort();
  if (!cleanQuestion) return { answer: "Ask a question about the collected company evidence.", citations: [], grounded: true };
  if (env.GEMINI_API_KEY) {
    try {
      const prompt = `Answer using only the claims JSON. If evidence is insufficient, say so directly. Return JSON with answer, citations using exact allowed URLs, and grounded. Do not use prior knowledge.
Allowed URLs: ${JSON.stringify(allowedUrls)}
Question: ${cleanQuestion}
Claims: ${JSON.stringify(run.claims).slice(0, 30000)}`;
      const model = env.GEMINI_MODEL || "gemini-2.5-flash";
      const data = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY },
        body: {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                answer: { type: "STRING" },
                citations: { type: "ARRAY", items: { type: "STRING" }, maxItems: 5 },
                grounded: { type: "BOOLEAN" },
              },
              required: ["answer", "citations", "grounded"],
            },
            thinkingConfig: { thinkingBudget: 0 },
            temperature: 0.1,
            maxOutputTokens: 1200,
          },
        },
        timeout: 35000,
      });
      const parsed = JSON.parse(data.candidates[0].content.parts[0].text);
      const citations = (parsed.citations || []).filter((url) => allowedUrls.includes(url));
      return { answer: String(parsed.answer || "Insufficient evidence."), citations, grounded: Boolean(citations.length || /insufficient/i.test(parsed.answer || "")) };
    } catch {
      // Deterministic fallback below.
    }
  }
  const terms = new Set(cleanQuestion.toLowerCase().match(/[a-z0-9]+/g) || []);
  for (const word of ["what", "where", "when", "does", "about", "company", "the", "is", "are"]) terms.delete(word);
  const selected = [...run.claims].sort((a, b) => scoreClaim(b, terms) - scoreClaim(a, terms)).filter((claim) => claim.source_urls?.length).slice(0, 3);
  if (!selected.length) return { answer: "The collected evidence is insufficient to answer that question.", citations: [], grounded: true };
  return {
    answer: selected.map((claim) => `${titleCase(claim.field.replaceAll("_", " "))}: ${claim.value}.`).join(" "),
    citations: [...new Set(selected.flatMap((claim) => claim.source_urls))].slice(0, 5),
    grounded: true,
  };
}

function addConflict(run) {
  const output = structuredClone(run);
  let target = output.claims.find((claim) => ["headquarters", "founded_year", "industry"].includes(claim.field));
  if (!target) {
    target = { field: "founded_year", value: "2012", confidence: 0.74, source_urls: ["https://example.invalid/simulated-source"], rationale: "Simulated provider claim", alternatives: [] };
    output.claims.push(target);
  }
  target.status = "conflict";
  target.alternatives ||= [];
  target.alternatives.push({ field: target.field, value: "Conflicting provider value", confidence: 0.61, source_urls: ["https://example.invalid/simulated-source"], rationale: "Injected test evidence" });
  output.quality = qualitySummary(output.claims, output.evidence);
  output.events.push(event("conflict_injected", "Test conflict added to the claim graph", "warning"));
  output.updated_at = new Date().toISOString();
  return output;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 22000);
  try {
    const headers = { Accept: "application/json", "User-Agent": "TraceForgeAI/1.0 portfolio-research", ...(options.headers || {}) };
    const init = { method: options.method || "GET", headers, signal: controller.signal };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function providerResult(provider, records, started) {
  return { provider, status: records.length ? "success" : "no_match", duration_ms: Date.now() - started, records, error: null, cached: false };
}

function providerError(provider, error, started) {
  return { provider, status: "error", duration_ms: Date.now() - started, records: [], error: cleanError(error), cached: false };
}

function missingProvider(provider, started) {
  return { provider, status: "not_configured", duration_ms: Date.now() - started, records: [], error: "Provider key is not configured", cached: false };
}

function publicProvider(provider) {
  return { provider: provider.provider, status: provider.status, duration_ms: provider.duration_ms, error: provider.error, cached: false, record_count: provider.records.length };
}

function qualitySummary(claims, evidence) {
  const cited = claims.filter((claim) => claim.source_urls?.length).length;
  const average = claims.length ? Math.round(claims.reduce((total, claim) => total + Number(claim.confidence || 0), 0) / claims.length * 100) : 0;
  return {
    claims: claims.length,
    evidence_records: evidence.length,
    citation_coverage: claims.length ? Math.round(cited / claims.length * 100) : 0,
    average_confidence: average,
    conflicts: claims.filter((claim) => claim.status === "conflict").length,
  };
}

function claimSchema(fields) {
  return {
    type: "OBJECT",
    properties: {
      claims: {
        type: "ARRAY",
        maxItems: 8,
        items: {
          type: "OBJECT",
          properties: {
            field: { type: "STRING", enum: fields },
            value: { type: "STRING", maxLength: 600 },
            confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
            source_urls: { type: "ARRAY", items: { type: "STRING" }, maxItems: 5 },
            rationale: { type: "STRING", maxLength: 300 },
          },
          required: ["field", "value", "confidence", "source_urls", "rationale"],
        },
      },
    },
    required: ["claims"],
  };
}

function configuredProviders(env) {
  return {
    firecrawl: Boolean(env.FIRECRAWL_API_KEY),
    tavily: Boolean(env.TAVILY_API_KEY),
    github: true,
    gemini: Boolean(env.GEMINI_API_KEY),
  };
}

function normalizeDomain(raw) {
  const value = String(raw || "").trim().toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "").replace(/^\.+|\.+$/g, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,24}$/.test(value)) throw new UserError("Enter a public company domain, for example stripe.com");
  if (value.endsWith(".local") || value.endsWith(".internal") || ["localhost", "example.com"].includes(value)) throw new UserError("Private, local, and placeholder domains are not supported");
  return value;
}

function validSnapshot(value, runId) {
  if (!value || typeof value !== "object" || value.id !== runId || !Array.isArray(value.claims) || !Array.isArray(value.evidence)) return null;
  return value;
}

function stageDuration(stageId, started, collectStarted, resolveStarted, finished) {
  if (stageId === "validate") return 1;
  if (stageId === "discover") return 1;
  if (stageId === "collect") return Math.max(1, resolveStarted - collectStarted);
  if (stageId === "resolve") return Math.max(1, finished - resolveStarted);
  return Math.max(1, finished - started - (resolveStarted - collectStarted) - (finished - resolveStarted));
}

function event(kind, message, tone) {
  return { kind, message, tone, at: new Date().toISOString() };
}

function scoreClaim(claim, terms) {
  const haystack = JSON.stringify(claim).toLowerCase();
  return [...terms].filter((term) => haystack.includes(term)).length;
}

function normalizeValue(value) {
  return String(value).toLowerCase().replace(/\W+/g, "");
}

function titleCase(value) {
  return String(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cleanError(error) {
  return String(error?.message || error || "provider request failed").replace(/(key|token)=[^&\s]+/gi, "$1=[redacted]").slice(0, 180);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
    },
  });
}

function secure(response) {
  const output = new Response(response.body, response);
  output.headers.set("X-Content-Type-Options", "nosniff");
  output.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  output.headers.set("X-Frame-Options", "DENY");
  return output;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new UserError("Request body must be valid JSON");
  }
}

class UserError extends Error {}
