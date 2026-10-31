// streamOut: waiting for "drain" must not leave "close" listeners behind (MaxListenersExceededWarning on big exports).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(os.tmpdir(), "seo-stream-"));
const { streamOut } = await import("../src/server.mjs");

class FakeRes extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.out = []; this.ended = false; this.maxClose = 0; }
  writeHead() {}
  write(chunk) {
    this.out.push(chunk);
    this.maxClose = Math.max(this.maxClose, this.listenerCount("close"));
    setImmediate(() => this.emit("drain")); // socket always full, then drains
    return false;
  }
  end() { this.ended = true; }
}

test("streamOut waits for drain without piling up close listeners", async () => {
  const res = new FakeRes();
  const chunks = Array.from({ length: 50 }, (_, i) => `chunk ${i}\n`);
  await streamOut(res, { __stream: chunks, type: "text/plain" });
  assert.equal(res.out.length, 50);
  assert.ok(res.ended);
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(res.listenerCount("drain"), 0);
  assert.ok(res.maxClose <= 1, `close listeners peaked at ${res.maxClose}`);
});

test("streamOut stops when the client goes", async () => {
  const res = new FakeRes();
  res.write = function (chunk) { this.out.push(chunk); setImmediate(() => { this.destroyed = true; this.emit("close"); }); return false; };
  await streamOut(res, { __stream: ["a", "b", "c"], type: "text/plain" });
  assert.equal(res.out.length, 1);
  assert.equal(res.listenerCount("drain"), 0);
});
