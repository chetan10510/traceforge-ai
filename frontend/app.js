const state = {
  run: null,
  pollTimer: null,
  activePane: "evidence",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  startView: $("#startView"),
  workspaceView: $("#workspaceView"),
  domainForm: $("#domainForm"),
  domainInput: $("#domainInput"),
  domainError: $("#domainError"),
  newRunBtn: $("#newRunBtn"),
  targetDomain: $("#targetDomain"),
  targetMonogram: $("#targetMonogram"),
  runMeta: $("#runMeta"),
  runStatus: $("#runStatus"),
  progressLabel: $("#progressLabel"),
  progressBar: $("#progressBar"),
  stageList: $("#stageList"),
  providerList: $("#providerList"),
  providerCount: $("#providerCount"),
  runningState: $("#runningState"),
  runningEyebrow: $("#runningEyebrow"),
  runningTitle: $("#runningTitle"),
  runningDetail: $("#runningDetail"),
  resultsState: $("#resultsState"),
  companyName: $("#companyName"),
  companySummary: $("#companySummary"),
  profileFacts: $("#profileFacts"),
  claimsList: $("#claimsList"),
  coverageMetric: $("#coverageMetric"),
  confidenceMetric: $("#confidenceMetric"),
  conflictMetric: $("#conflictMetric"),
  evidenceCount: $("#evidenceCount"),
  evidencePane: $("#evidencePane"),
  eventsPane: $("#eventsPane"),
  exportBtn: $("#exportBtn"),
  conflictBtn: $("#conflictBtn"),
  askBar: $("#askBar"),
  askForm: $("#askForm"),
  questionInput: $("#questionInput"),
  answerDialog: $("#answerDialog"),
  answerQuestion: $("#answerQuestion"),
  answerText: $("#answerText"),
  answerCitations: $("#answerCitations"),
  toast: $("#toast"),
};

elements.domainForm.addEventListener("submit", (event) => {
  event.preventDefault();
  startInvestigation(elements.domainInput.value);
});

$$('[data-domain]').forEach((button) => {
  button.addEventListener("click", () => {
    elements.domainInput.value = button.dataset.domain;
    startInvestigation(button.dataset.domain);
  });
});

elements.newRunBtn.addEventListener("click", resetWorkspace);
elements.exportBtn.addEventListener("click", exportEvidence);
elements.conflictBtn.addEventListener("click", injectConflict);
elements.askForm.addEventListener("submit", askEvidence);
$("#closeAnswer").addEventListener("click", () => elements.answerDialog.close());

$$('[data-pane]').forEach((button) => {
  button.addEventListener("click", () => switchPane(button.dataset.pane));
});

async function startInvestigation(rawDomain) {
  const domain = normalizeDomain(rawDomain);
  elements.domainError.textContent = "";
  if (!domain) {
    elements.domainError.textContent = "Enter a valid public company domain, such as stripe.com.";
    return;
  }

  clearTimeout(state.pollTimer);
  showWorkspace(domain);
  try {
    const run = await api("/api/investigations", {
      method: "POST",
      body: JSON.stringify({ domain }),
    });
    state.run = run;
    render(run);
    if (!isTerminal(run.status)) schedulePoll();
  } catch (error) {
    showStartError(error.message);
  }
}

async function pollRun() {
  if (!state.run?.id) return;
  try {
    const run = await api(`/api/investigations/${encodeURIComponent(state.run.id)}`);
    state.run = run;
    render(run);
    if (!isTerminal(run.status)) schedulePoll();
  } catch (error) {
    toast(`Run refresh failed: ${error.message}`);
    state.pollTimer = setTimeout(pollRun, 2200);
  }
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(pollRun, 900);
}

function showWorkspace(domain) {
  elements.startView.classList.add("hidden");
  elements.workspaceView.classList.remove("hidden");
  elements.newRunBtn.classList.remove("hidden");
  elements.runningState.classList.remove("hidden");
  elements.resultsState.classList.add("hidden");
  elements.askBar.classList.add("hidden");
  elements.exportBtn.disabled = true;
  elements.conflictBtn.disabled = true;
  elements.targetDomain.textContent = domain;
  elements.targetMonogram.textContent = domain.charAt(0).toUpperCase();
  elements.runMeta.textContent = "Creating typed connector run";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetWorkspace() {
  clearTimeout(state.pollTimer);
  state.run = null;
  elements.workspaceView.classList.add("hidden");
  elements.startView.classList.remove("hidden");
  elements.newRunBtn.classList.add("hidden");
  elements.domainInput.value = "";
  elements.domainError.textContent = "";
  elements.domainInput.focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function render(run) {
  elements.targetDomain.textContent = run.domain || "Unknown target";
  elements.targetMonogram.textContent = (run.domain || "?").charAt(0).toUpperCase();
  elements.progressLabel.textContent = `${run.progress || 0}%`;
  elements.progressBar.style.width = `${run.progress || 0}%`;
  elements.runMeta.textContent = `${run.cached ? "Cache replay" : "Live run"} · ${shortId(run.id)} · ${formatTime(run.created_at)}`;
  renderStatus(run);
  renderStages(run.stages || []);
  renderProviders(run.providers || []);
  renderEvidence(run.evidence || []);
  renderEvents(run.events || []);

  if (run.status === "complete") {
    renderResults(run);
  } else if (run.status === "failed") {
    renderFailure(run);
  } else {
    renderRunning(run);
  }
}

function renderStatus(run) {
  const status = run.status === "queued" ? "running" : run.status;
  elements.runStatus.className = `run-status ${escapeClass(status)}`;
  elements.runStatus.innerHTML = `<i></i>${escapeHtml(titleCase(run.status || "running"))}`;
}

function renderStages(stages) {
  elements.stageList.innerHTML = stages.map((stage, index) => {
    const marker = stage.status === "complete" ? "✓" : stage.status === "failed" ? "!" : String(index + 1).padStart(2, "0");
    const duration = stage.duration_ms == null ? "" : `<span class="stage-duration">${formatDuration(stage.duration_ms)}</span>`;
    return `<article class="stage-item ${escapeClass(stage.status)}">
      <span class="stage-state">${marker}</span>
      <div><strong>${escapeHtml(stage.label)}</strong><small>${escapeHtml(stage.description)}</small>${duration}</div>
    </article>`;
  }).join("");
}

function renderProviders(providers) {
  const settled = providers.length;
  const healthy = providers.filter((provider) => provider.status === "success").length;
  elements.providerCount.textContent = `${settled} / 3`;
  if (!settled) {
    elements.providerList.innerHTML = '<p class="muted">Providers appear as they settle.</p>';
    return;
  }
  elements.providerList.innerHTML = providers.map((provider) => `
    <article class="provider-item" title="${escapeHtml(provider.error || provider.status)}">
      <span>${escapeHtml(provider.provider.slice(0, 2))}</span>
      <div><strong>${escapeHtml(provider.provider)}</strong><small>${provider.record_count ?? provider.records?.length ?? 0} records · ${formatDuration(provider.duration_ms)}</small></div>
      <b class="provider-state ${escapeClass(provider.status)}">${escapeHtml(provider.status.replaceAll("_", " "))}</b>
    </article>`).join("") + (settled === 3 ? `<p class="muted">${healthy} connectors returned populated data.</p>` : "");
}

function renderRunning(run) {
  const stage = (run.stages || []).find((item) => item.id === run.current_stage);
  elements.runningState.classList.remove("hidden");
  elements.resultsState.classList.add("hidden");
  elements.runningEyebrow.textContent = (stage?.label || "Preparing").toUpperCase();
  elements.runningTitle.textContent = stage?.description || "Preparing the investigation";
  elements.runningDetail.textContent = run.providers?.length
    ? `${run.providers.length} of 3 connectors settled. Provider results remain independently auditable.`
    : "The first provider results will appear here.";
}

function renderFailure(run) {
  elements.runningState.classList.remove("hidden");
  elements.resultsState.classList.add("hidden");
  elements.runningEyebrow.textContent = "RUN FAILED";
  elements.runningTitle.textContent = "The pipeline stopped safely";
  elements.runningDetail.textContent = run.error || "Review the run log, then start a new investigation.";
}

function renderResults(run) {
  elements.runningState.classList.add("hidden");
  elements.resultsState.classList.remove("hidden");
  elements.askBar.classList.remove("hidden");
  elements.exportBtn.disabled = false;
  elements.conflictBtn.disabled = false;

  const claims = run.claims || [];
  const claim = (field) => claims.find((item) => item.field === field);
  elements.companyName.textContent = displayValue(claim("company_name")?.value) || run.domain;
  elements.companySummary.textContent = displayValue(claim("summary")?.value) || "No supported summary was returned. The empty result is preserved rather than guessed.";

  const facts = ["industry", "headquarters", "founded_year"]
    .map((field) => claim(field))
    .filter(Boolean);
  elements.profileFacts.innerHTML = facts.map((item) => `<span><b>${escapeHtml(titleCase(item.field))}</b> · ${escapeHtml(displayValue(item.value))}</span>`).join("")
    + `<span><b>AI extraction</b> · ${escapeHtml(titleCase(run.model?.status || "not configured"))}</span>`;

  const quality = run.quality || {};
  elements.coverageMetric.textContent = `${quality.citation_coverage || 0}%`;
  elements.confidenceMetric.textContent = `${quality.average_confidence || 0}%`;
  elements.conflictMetric.textContent = quality.conflicts || 0;
  renderClaims(claims);
}

function renderClaims(claims) {
  if (!claims.length) {
    elements.claimsList.innerHTML = '<p class="empty-result">No defensible claims were extracted. TraceForge does not fill evidence gaps with guesses.</p>';
    return;
  }
  elements.claimsList.innerHTML = claims.map((claim) => {
    const urls = (claim.source_urls || []).filter(isSafeHttpUrl);
    const sourceLink = urls.length
      ? `<a class="claim-sources" href="${escapeAttribute(urls[0])}" target="_blank" rel="noopener noreferrer" title="Open primary source">${urls.length}</a>`
      : '<span class="claim-sources">0</span>';
    const alternatives = (claim.alternatives || []).map((item) => displayValue(item.value)).filter(Boolean);
    const conflict = claim.status === "conflict"
      ? `<div class="claim-conflict">Conflict retained${alternatives.length ? `: ${escapeHtml(alternatives.join(" · "))}` : " for manual review"}</div>`
      : "";
    return `<article class="claim-row">
      <span class="claim-field">${escapeHtml(claim.field.replaceAll("_", " "))}</span>
      <div class="claim-value"><strong>${escapeHtml(displayValue(claim.value))}</strong><small>${escapeHtml(claim.rationale || "Evidence-backed public claim")}</small>${conflict}</div>
      <div class="claim-confidence"><b>${Math.round(Number(claim.confidence || 0) * 100)}%</b><span>${escapeHtml(claim.status || "verified")}</span></div>
      ${sourceLink}
    </article>`;
  }).join("");
}

function renderEvidence(evidence) {
  elements.evidenceCount.textContent = evidence.length;
  if (!evidence.length) {
    elements.evidencePane.innerHTML = '<p class="muted">Evidence records will appear after collection.</p>';
    return;
  }
  elements.evidencePane.innerHTML = evidence.map((item) => {
    const safeUrl = isSafeHttpUrl(item.url) ? item.url : "#";
    return `<article class="evidence-item">
      <span class="evidence-icon">${escapeHtml((item.provider || "ev").slice(0, 2))}</span>
      <div><a href="${escapeAttribute(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || item.url || "Untitled evidence")}</a>
      <p>${escapeHtml(truncate(item.content || "Structured provider metadata", 190))}</p>
      <div class="evidence-meta"><span>${escapeHtml(item.provider || "provider")}</span><span>${escapeHtml((item.source_type || "record").replaceAll("_", " "))}</span></div></div>
    </article>`;
  }).join("");
}

function renderEvents(events) {
  if (!events.length) {
    elements.eventsPane.innerHTML = '<p class="muted">Run events will appear here.</p>';
    return;
  }
  elements.eventsPane.innerHTML = [...events].reverse().map((item) => `
    <article class="event-item ${escapeClass(item.tone)}">
      <strong>${escapeHtml(item.kind.replaceAll("_", " ").toUpperCase())} · ${formatTime(item.at)}</strong>
      <small>${escapeHtml(item.message)}</small>
    </article>`).join("");
}

function switchPane(pane) {
  state.activePane = pane;
  $$('[data-pane]').forEach((button) => button.classList.toggle("active", button.dataset.pane === pane));
  elements.evidencePane.classList.toggle("hidden", pane !== "evidence");
  elements.eventsPane.classList.toggle("hidden", pane !== "events");
}

async function injectConflict() {
  if (!state.run?.id) return;
  elements.conflictBtn.disabled = true;
  try {
    state.run = await api(`/api/investigations/${encodeURIComponent(state.run.id)}/conflict`, { method: "POST", body: "{}" });
    render(state.run);
    toast("Test conflict retained in the canonical claim ledger.");
  } catch (error) {
    toast(error.message);
  } finally {
    elements.conflictBtn.disabled = false;
  }
}

async function askEvidence(event) {
  event.preventDefault();
  const question = elements.questionInput.value.trim();
  if (!question || !state.run?.id) return;
  const button = elements.askForm.querySelector("button");
  button.disabled = true;
  button.textContent = "Checking...";
  try {
    const response = await api(`/api/investigations/${encodeURIComponent(state.run.id)}/ask`, {
      method: "POST",
      body: JSON.stringify({ question }),
    });
    elements.answerQuestion.textContent = question;
    elements.answerText.textContent = response.answer;
    const citations = (response.citations || []).filter(isSafeHttpUrl);
    elements.answerCitations.innerHTML = citations.length
      ? citations.map((url, index) => `<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">Source ${index + 1} · ${escapeHtml(url)}</a>`).join("")
      : '<p class="muted">No citation was available; the answer reports insufficient evidence.</p>';
    elements.answerDialog.showModal();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Ask →";
  }
}

function exportEvidence() {
  if (!state.run) return;
  const payload = {
    schema_version: "1.0",
    exported_at: new Date().toISOString(),
    investigation: state.run,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `traceforge-${state.run.domain}-${state.run.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
  toast("Evidence package exported.");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok) throw new Error(payload.message || payload.error || `Request failed (${response.status})`);
  return payload;
}

function normalizeDomain(value) {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].replace(/\.$/, "");
}

function isTerminal(status) {
  return status === "complete" || status === "failed";
}

function isSafeHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function displayValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return value == null ? "" : String(value);
}

function formatDuration(milliseconds) {
  const value = Number(milliseconds || 0);
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function formatTime(value) {
  if (!value) return "now";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "now" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function titleCase(value) {
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortId(value) {
  return value ? `run_${value.slice(0, 7)}` : "pending";
}

function truncate(value, length) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function escapeClass(value) {
  return String(value || "").replace(/[^a-z0-9_-]/gi, "");
}

function showStartError(message) {
  resetWorkspace();
  elements.domainError.textContent = message;
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => elements.toast.classList.add("hidden"), 3500);
}

const linkedDomain = new URLSearchParams(window.location.search).get("domain");
if (linkedDomain) {
  elements.domainInput.value = linkedDomain;
  startInvestigation(linkedDomain);
}
