// Business listings (REQ-039, 2026-10-26): directory pages checked against the site's name, address and phone,
// with abbreviations and phone formats treated as the same, bot walls reported as "check by hand". Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run } = await import("../src/db.mjs");
const { normText, normPhone, phonesIn, napFromHtml, addressParts, compareListing, addCitation, removeCitation, checkCitations, citationsData, referenceNap } =
  await import("../src/citations.mjs");

const SITE = "https://acmemotors.com.au/";
const NAP = { name: "Acme Motors Pty Ltd", address: "12 Example Street, Springfield VIC 3999", phone: "03 9000 1234" };
run("INSERT INTO projects (id, name, start_url) VALUES (990, 'Acme Motors', ?)", SITE);
const project = { id: 990, start_url: SITE, settings: "{}" };

const home = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Acme"},
  {"@type":["AutoRepair","LocalBusiness"],"name":"Acme Motors","telephone":"+61 3 9000 1234",
   "address":{"@type":"PostalAddress","streetAddress":"12 Example Street","addressLocality":"Springfield","addressRegion":"VIC","postalCode":"3999"}}]}</script></head><body>Hi</body></html>`;
const listing = (body) => `<html><body>${body}</body></html>`;

test("abbreviations, punctuation and phone formats normalise to the same thing", () => {
  assert.equal(normText("12 Example St."), normText("12 example street"));
  assert.equal(normText("415 Sth Gippsland Hwy"), "415 sth gippsland highway");
  assert.equal(normPhone("+61 3 9000 1234"), "0390001234");
  assert.equal(normPhone("(03) 9000 1234"), "0390001234");
  assert.deepEqual(phonesIn("Call (03) 9000 1234 or 0412 345 678, or 1300 123 456. ABN 12 345 678 901"), ["0390001234", "0412345678", "1300123456"]);
});

test("the business's details come from the home page's LocalBusiness JSON-LD", () => {
  assert.deepEqual(napFromHtml(home), { name: "Acme Motors", address: "12 Example Street, Springfield, VIC, 3999", phone: "+61 3 9000 1234" });
  assert.equal(napFromHtml("<html><body>no schema</body></html>"), null);
  assert.deepEqual(addressParts(NAP.address), { street: "12 example street", suburb: "springfield", postcode: "3999" });
});

test("a listing with the same details written differently matches; old address or other phone does not", () => {
  const same = compareListing(listing(`<h1>ACME MOTORS</h1><p>12 Example St, Springfield VIC 3999</p><a href="tel:0390001234">Call</a>
    <a href="https://dir.example/out?u=https%3A%2F%2Facmemotors.com.au">Website</a>`), NAP, SITE);
  assert.deepEqual([same.status, same.name_ok, same.address_ok, same.phone_ok, same.website_ok], ["match", 1, 1, 1, 1]);
  const old = compareListing(listing("<h1>Acme Motors</h1><p>415 Old Highway, Springfield VIC 3998</p><p>03 9000 1234</p>"), NAP, SITE);
  assert.deepEqual([old.status, old.address_ok, old.phone_ok, old.website_ok], ["mismatch", 0, 1, 0]);
  const phone = compareListing(listing("<h1>Acme Motors</h1><p>12 Example Street Springfield 3999</p><p>Ph 03 9555 0000</p><p>Directory help 1300 000 111</p>"), NAP, SITE);
  assert.deepEqual([phone.status, phone.phone_ok], ["mismatch", 0]);
  assert.deepEqual(phone.other_phones, ["0395550000"], "the other number is shown; the directory's own 1300 number is not");
});

test("listings are added, checked, and a bot wall or a missing page is reported, not counted as wrong", async () => {
  assert.throws(() => addCitation(990, "not a url"), /full listing address/);
  for (const u of ["https://dir-a.example/acme", "https://www.dir-b.example/listing/1", "https://dir-c.example/x", "https://dir-d.example/gone"]) addCitation(990, u);
  addCitation(990, "https://dir-a.example/acme"); // duplicate ignored
  const pages = {
    [SITE]: { ok: true, status: 200, html: home },
    "https://dir-a.example/acme": { ok: true, status: 200, html: listing("Acme Motors · 12 Example Street, Springfield VIC 3999 · (03) 9000 1234") },
    "https://www.dir-b.example/listing/1": { ok: true, status: 200, html: listing("Acme Motors · 415 Old Highway, Springfield 3998 · 03 9000 1234") },
    "https://dir-c.example/x": { ok: false, status: 403, html: "<html>Access denied</html>" },
    "https://dir-d.example/gone": { ok: false, status: 404, html: "" },
  };
  const r = await checkCitations(project, { fetchPage: async (u) => pages[u] });
  await r.done;
  assert.equal(r.nap.source, "site");
  const d = citationsData(project);
  assert.deepEqual([d.total, d.match, d.mismatch, d.blocked], [4, 1, 1, 1]);
  const by = Object.fromEntries(d.rows.map((x) => [x.site, x]));
  assert.equal(by["dir-b"].address_ok, 0);
  assert.equal(by["dir-d"].status, "gone");
  assert.equal(d.noWebsite, 1, "the matching listing has no link to the site");
  removeCitation(990, "https://dir-d.example/gone");
  assert.equal(citationsData(project).total, 3);
});

test("details in Settings take priority over the home page", async () => {
  const p = { ...project, settings: JSON.stringify({ napName: "Acme", napAddress: "1 New Road, Springfield VIC 3999", napPhone: "03 9000 9999" }) };
  const nap = await referenceNap(p, async () => { throw new Error("must not fetch"); });
  assert.deepEqual(nap, { name: "Acme", address: "1 New Road, Springfield VIC 3999", phone: "03 9000 9999", source: "settings" });
});
