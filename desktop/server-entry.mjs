// Runs inside Electron's utility process: the SEO Auditor server (and, through it, the link engine).
// Data folders arrive as environment variables from desktop/main.mjs.
const { startServer } = await import("../src/server.mjs");
try {
  await startServer();
  process.parentPort?.postMessage({ ready: true });
} catch (e) {
  process.parentPort?.postMessage({ ready: false, error: e.code === "EADDRINUSE" ? "in-use" : String(e.message || e) });
}
