/**
 * common.js — shared utilities loaded by every page.
 * Served as a static file: <script src="/common.js"></script>
 *
 * Contains: escapeHtml, jsonFetch, stageToIndex, statusBadge, createPoller
 */

// ---------------------------------------------------------------------------
// HTML escaping — prevent XSS when inserting untrusted text into the DOM.
// ---------------------------------------------------------------------------
function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------------------------------------------------------------------------
// Fetch wrapper — throws a meaningful Error on HTTP error or ok:false body.
// ---------------------------------------------------------------------------
async function jsonFetch(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({ ok: false, message: "Invalid JSON response" }));
  if (!res.ok || body.ok === false) {
    throw new Error(body.message || `Request failed (${res.status})`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Pipeline stage → stepper index (0 = scanning … 5 = done).
// Accepts both -ing API forms ("downloading") and bare base forms ("download").
// ---------------------------------------------------------------------------
function stageToIndex(stage, status) {
  if (status === "done") return 5;
  if (stage === "resolving"   || stage === "resolve")   return 1;
  if (stage === "downloading" || stage === "download")  return 2;
  if (stage === "parsing"     || stage === "parse")     return 3;
  if (stage === "summarizing" || stage === "summarize") return 4;
  if (stage === "writing"     || stage === "done")      return 5;
  return 0; // "scanning" / "queued" / unrecognised → step 0
}

// ---------------------------------------------------------------------------
// Render a small coloured status badge <span>.
// ---------------------------------------------------------------------------
function statusBadge(status) {
  const value = status === "failed" ? "error" : status;
  return `<span class="status-badge status-${escapeHtml(value)}"><span class="dot"></span>${escapeHtml(value)}</span>`;
}

// ---------------------------------------------------------------------------
// Polling factory — returns { start(), stop() } that calls refreshFn every
// intervalMs milliseconds.  Calling start() while already polling is a no-op.
//
// Usage:
//   const poller = createPoller(myRefreshFn);
//   poller.start();   // begin
//   poller.stop();    // pause
// ---------------------------------------------------------------------------
function createPoller(refreshFn, intervalMs = 3000) {
  let timer = null;
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => Promise.resolve(refreshFn()).catch(() => {}), intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
