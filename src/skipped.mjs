// Visible failures (REQ-055 group 9): a site-wide check group that fails (network error, a bug, no browser) used to
// return an empty list silently, which reads as "checked and fine". Now each failure is recorded as
// { step, reason } in the audit's site_info.skipped and shown on the Overview, so "not checked" is never mistaken for
// "passed". The checks' results are unchanged: a failing group still contributes no issues.

const clean = (e, redact) => redact(String(e?.message || e || "unknown error").split("\n")[0]).replace(/\s+/g, " ").trim().slice(0, 200);

/** A per-audit list. guard(step, work, fallback) runs work (a function or a promise) and resolves to its value, or
 *  records the failure and resolves to fallback. note(step, reason) records a step skipped for a known reason (no
 *  browser). redact removes secrets (the project's request header values) from messages. */
export function createSkips({ redact = (s) => s } = {}) {
  const list = [];
  const note = (step, reason) => { if (!list.some((x) => x.step === step)) list.push({ step, reason: clean(reason, redact) }); };
  const guard = async (step, work, fallback) => {
    try { return await (typeof work === "function" ? work() : work); } catch (e) { note(step, e); return fallback; }
  };
  return { list, note, guard, summary: () => (list.length ? list.map((x) => ({ ...x })) : undefined) };
}
