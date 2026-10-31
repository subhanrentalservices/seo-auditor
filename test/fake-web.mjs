// A fake web for research tests: { url: [status, body, type] }; records each request (url, user agent, fake time).
// sleep() advances the fake clock, so polite gaps cost no real time.
export function fakeWeb(site) {
  const calls = [];
  let t = 1_000_000;
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, ua: init.headers?.["User-Agent"], at: t });
    const [status, body = "", type = "text/html"] = site[url] || [404, "", "text/html"];
    if (status === "throw") throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return new Response(status === 200 ? body : null, { status, headers: { "content-type": type } });
  };
  return { calls, fetchFn, now: () => t, sleep: async (ms) => { t += ms; }, tick: (ms) => { t += ms; } };
}
