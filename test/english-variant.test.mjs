// English variant checker for the Human Writer tab. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkVariant, fixVariant, variantPrompt, VARIANTS } from "../src/english-variant.mjs";

const words = (r) => r.hits.map((h) => h.word.toLowerCase()).sort();
const SAMPLE = "We analyzed the colour of the centre and organised a catalog. The gray box was canceled.";

test("American: British spellings are flagged with the American form", () => {
  const r = checkVariant(SAMPLE, "us");
  assert.deepEqual(words(r), ["centre", "colour", "organised"]);
  assert.equal(r.hits.find((h) => h.word === "colour").suggestion, "color");
});

test("British and Australian: American spellings are flagged", () => {
  for (const v of ["uk", "au", "in"]) assert.deepEqual(words(checkVariant(SAMPLE, v)), ["analyzed", "canceled", "catalog", "gray"]);
});

test("Canadian: -ize and -yze like American, -our, -re, -ll and grey like British", () => {
  assert.deepEqual(words(checkVariant(SAMPLE, "ca")), ["canceled", "catalog", "gray", "organised"]);
  assert.equal(checkVariant("My mom analyzed the colour of the airplane.", "ca").hits.length, 0);
  assert.deepEqual(words(checkVariant("My mum flew in an aeroplane.", "ca")), ["aeroplane", "mum"]);
});

test("words that are the same or have another meaning are never flagged", () => {
  const t = "Advertise, exercise, surprise, advise and revise. The size prize. A license to practice. Check the tire and the program. Humorous, laborious, honorary.";
  for (const v of ["us", "uk", "au", "ca", "in"]) assert.deepEqual(checkVariant(t, v).hits, [], v);
});

test("code, URLs, link targets and bold UI labels keep their spelling", () => {
  const t = "Open **Color** settings, run `colorize()` or see [the guide](https://example.com/color-center).";
  assert.deepEqual(checkVariant(t, "uk").hits, []);
  assert.equal(fixVariant(t, "uk"), t);
});

test("capitalised words mid-sentence are marked as possible names and not auto-fixed", () => {
  const t = "Colour matters. The Department of Defense and the Kennedy Center analyzed it.";
  const r = checkVariant(t, "uk");
  assert.ok(r.hits.find((h) => h.word === "Defense").maybeName);
  assert.equal(fixVariant(t, "uk"), "Colour matters. The Department of Defense and the Kennedy Center analysed it.");
  assert.equal(fixVariant("Gray boxes. Color is fine.", "uk"), "Grey boxes. Colour is fine.");
});

test("fixVariant keeps case and inflection", () => {
  assert.equal(fixVariant("COLOR, colors, colored, favorite, organization, traveling", "uk"),
    "COLOUR, colours, coloured, favourite, organisation, travelling");
  assert.equal(fixVariant("colours, organisation, travelled, centres", "us"), "colors, organization, traveled, centers");
});

test("neutral reports mixed spelling instead of hits", () => {
  const r = checkVariant(SAMPLE, "neutral");
  assert.equal(r.mixed, true);
  assert.equal(checkVariant("The color of the center.", "neutral").mixed, false);
});

test("every variant has prompt rules that forbid converting numbers and units", () => {
  for (const id of Object.keys(VARIANTS)) {
    const p = variantPrompt(id);
    assert.match(p, /Never convert numbers, units, prices or currencies/);
    assert.match(p, new RegExp(VARIANTS[id].label.replace(/[()]/g, ".")));
  }
});
