// English variants for the Human Writer tab (owner, 15 Nov 2026: "write selected type of English like American, UK,
// Australia which one I select"). Two parts:
//   - VARIANTS: what Claude is told about spelling, vocabulary, dates and punctuation for each variant.
//   - checkVariant(text, id): finds spellings that belong to another variant, so a rewrite can be checked mechanically.
// Numbers, units and money are never converted: they are facts and stay exactly as written (metres stay metres in a US
// text if the source said metres). Only spelling, word choice and date order change.
// Only pairs whose "wrong" form has no other meaning in the target variant are checked. Left out on purpose:
// license/licence and practice/practise (UK verbs), program (UK computing), tire, check, meter, story, draft, curb,
// judgment/judgement, ageing/aging, artifact/artefact, dialog, analog, inquiry (both forms in use).

/** -ize/-ise stems. Only these: size, seize, prize and advertise, exercise, surprise, advise, revise... never change. */
const IZE = ["organ", "real", "recogn", "optim", "custom", "minim", "maxim", "priorit", "depriorit", "summar", "emphas",
  "categor", "author", "standard", "normal", "util", "special", "final", "apolog", "critic", "modern", "visual",
  "synchron", "initial", "personal", "character", "general", "popular", "memor", "local", "global", "monet",
  "capital", "central", "decentral", "familiar", "legal", "neutral", "random", "sanit", "steril", "symbol", "digit",
  "item", "harmon", "jeopard", "mobil", "stabil", "subsid", "theor", "trivial", "rational", "colon", "agon", "patron",
  "scrutin", "sympath", "fertil", "hospital", "industrial", "commercial", "energ", "equal", "fantas", "human", "ideal",
  "immun", "internal", "legitim", "magnet", "material", "mechan", "moral", "natural", "polar", "pressur", "public",
  "regular", "revital", "romantic", "secular", "sensit", "desensit", "serial", "social", "terror", "vocal", "anonym",
  "compartmental", "contextual", "formal", "hypothes", "incentiv", "institutional", "marginal", "metabol", "miniatur",
  "national", "operational", "parameter", "penal", "radical", "reorgan", "revolution", "verbal", "victim", "econom",
  "amort"];
const IZE_SUFFIX = [["ize", "ise"], ["izes", "ises"], ["ized", "ised"], ["izing", "ising"], ["izer", "iser"], ["izers", "isers"],
  ["ization", "isation"], ["izations", "isations"], ["izable", "isable"]];

/** -or/-our bases with the endings that take the u. humorous, laborious, honorary are the same everywhere. */
const OUR = ["color", "flavor", "favor", "honor", "humor", "labor", "neighbor", "behavior", "harbor", "rumor", "vapor",
  "odor", "armor", "savor", "endeavor", "parlor", "valor", "vigor", "clamor", "splendor", "candor", "fervor"];
const OUR_SUFFIX = ["", "s", "ed", "ing", "ful", "ite", "ites", "able", "less", "hood", "er", "ers", "al", "y"];

/** [US, British] spelled out, for endings that don't follow a simple rule. */
const RE = [["center", "centre"], ["centers", "centres"], ["centered", "centred"], ["centering", "centring"],
  ["theater", "theatre"], ["theaters", "theatres"], ["fiber", "fibre"], ["fibers", "fibres"], ["liter", "litre"],
  ["liters", "litres"], ["kilometer", "kilometre"], ["kilometers", "kilometres"], ["centimeter", "centimetre"],
  ["centimeters", "centimetres"], ["millimeter", "millimetre"], ["millimeters", "millimetres"], ["somber", "sombre"],
  ["luster", "lustre"], ["meager", "meagre"], ["saber", "sabre"], ["specter", "spectre"], ["maneuver", "manoeuvre"],
  ["maneuvers", "manoeuvres"]];
const YZE = ["analy", "paraly", "cataly"].flatMap((s) => [["ze", "se"], ["zes", "ses"], ["zed", "sed"], ["zing", "sing"],
  ["zer", "ser"], ["zers", "sers"]].map(([u, b]) => [s + u, s + b]));
const LL = [["traveled", "travelled"], ["traveling", "travelling"], ["traveler", "traveller"], ["travelers", "travellers"],
  ["canceled", "cancelled"], ["canceling", "cancelling"], ["labeled", "labelled"], ["labeling", "labelling"],
  ["modeled", "modelled"], ["modeling", "modelling"], ["fueled", "fuelled"], ["fueling", "fuelling"],
  ["signaled", "signalled"], ["signaling", "signalling"], ["totaled", "totalled"], ["totaling", "totalling"],
  ["leveled", "levelled"], ["leveling", "levelling"], ["jeweler", "jeweller"], ["jewelers", "jewellers"],
  ["counselor", "counsellor"], ["counselors", "counsellors"], ["marveled", "marvelled"], ["marvelous", "marvellous"],
  ["channeled", "channelled"], ["channeling", "channelling"], ["tunneled", "tunnelled"], ["dueling", "duelling"],
  ["enrollment", "enrolment"], ["enrollments", "enrolments"], ["fulfillment", "fulfilment"], ["skillful", "skilful"],
  ["willful", "wilful"], ["installment", "instalment"], ["installments", "instalments"]];
const ENCE = [["defense", "defence"], ["defenses", "defences"], ["offense", "offence"], ["offenses", "offences"],
  ["pretense", "pretence"]];
const OGUE = [["catalog", "catalogue"], ["catalogs", "catalogues"], ["cataloged", "catalogued"], ["monolog", "monologue"],
  ["epilog", "epilogue"], ["prolog", "prologue"]];
const MISC_UK = [["gray", "grey"], ["grays", "greys"], ["jewelry", "jewellery"], ["aluminum", "aluminium"],
  ["pajamas", "pyjamas"], ["mold", "mould"], ["molds", "moulds"], ["moldy", "mouldy"], ["skeptic", "sceptic"],
  ["skeptical", "sceptical"], ["skepticism", "scepticism"], ["plow", "plough"], ["cozy", "cosy"], ["mustache", "moustache"],
  ["donut", "doughnut"], ["donuts", "doughnuts"], ["mom", "mum"], ["moms", "mums"], ["airplane", "aeroplane"],
  ["airplanes", "aeroplanes"], ["fetus", "foetus"], ["esophagus", "oesophagus"], ["anemia", "anaemia"],
  ["anesthesia", "anaesthesia"], ["pediatric", "paediatric"], ["estrogen", "oestrogen"], ["diarrhea", "diarrhoea"]];

const pairs = (list) => list.map(([u, b]) => ({ us: u, uk: b }));
const GROUPS = {
  ize: IZE.flatMap((s) => IZE_SUFFIX.map(([u, b]) => ({ us: s + u, uk: s + b }))),
  our: OUR.flatMap((b) => OUR_SUFFIX.map((x) => ({ us: b + x, uk: b.replace(/or$/, "our") + x }))),
  re: pairs(RE), yze: pairs(YZE), ll: pairs(LL), ence: pairs(ENCE), ogue: pairs(OGUE), misc: pairs(MISC_UK),
};
// Canada: British -our, -re, -ll, -ence, -ogue, grey, jewellery; American -ize, -yze, and mom, plow, cozy, mold,
// skeptic, aluminum, airplane, donut, pajamas (Canadian Press style).
const CA_US_MISC = new Set(["mom", "moms", "plow", "cozy", "mold", "molds", "moldy", "skeptic", "skeptical", "skepticism",
  "aluminum", "airplane", "airplanes", "donut", "donuts", "pajamas", "mustache", "fetus", "esophagus", "anemia",
  "anesthesia", "pediatric", "estrogen", "diarrhea"]);

/** Which side each variant takes, per group: "us" or "uk". */
const SIDE = {
  us: { ize: "us", our: "us", re: "us", yze: "us", ll: "us", ence: "us", ogue: "us", misc: "us" },
  uk: { ize: "uk", our: "uk", re: "uk", yze: "uk", ll: "uk", ence: "uk", ogue: "uk", misc: "uk" },
  au: { ize: "uk", our: "uk", re: "uk", yze: "uk", ll: "uk", ence: "uk", ogue: "uk", misc: "uk" },
  in: { ize: "uk", our: "uk", re: "uk", yze: "uk", ll: "uk", ence: "uk", ogue: "uk", misc: "uk" },
  ca: { ize: "us", our: "uk", re: "uk", yze: "us", ll: "uk", ence: "uk", ogue: "uk", misc: "ca" },
};

export const VARIANTS = {
  us: {
    label: "American English",
    spelling: "color, center, organize, analyze, traveled, defense, catalog, gray, jewelry, aluminum, mom",
    vocabulary: "apartment, cell phone, vacation, gas (fuel), zip code, truck, sidewalk, line (queue), fall (autumn), math, cookie, store",
    dates: "November 15, 2026 (month first); 11/15/2026 only in tables",
    punctuation: "double quotation marks, with commas and periods inside the closing quote; serial (Oxford) comma",
  },
  uk: {
    label: "British English",
    spelling: "colour, centre, organise, analyse, travelled, defence, catalogue, grey, jewellery, aluminium, mum",
    vocabulary: "flat, mobile (phone), holiday, petrol, postcode, lorry, pavement, queue, autumn, maths, biscuit, shop",
    dates: "15 November 2026 (day first); 15/11/2026 only in tables",
    punctuation: "punctuation inside quotes only when it belongs to the quoted words; serial comma only where it avoids confusion",
  },
  au: {
    label: "Australian English",
    spelling: "colour, centre, organise, analyse, travelled, defence, catalogue, grey, jewellery, aluminium, mum (Macquarie and the Australian Government Style Manual)",
    vocabulary: "flat or unit, mobile (phone), holiday, petrol, postcode, footpath, queue, autumn, maths, biscuit, shop, program (Australia uses program, not programme). Plain professional register: no slang such as arvo, brekkie or heaps unless the purpose is casual",
    dates: "15 November 2026 (day first)",
    punctuation: "single or double quotation marks used consistently, punctuation inside only when it belongs to the quote; no serial comma unless it avoids confusion",
  },
  ca: {
    label: "Canadian English",
    spelling: "colour, centre, organize, analyze, travelled, defence, catalogue, grey, jewellery, cheque, but mom, aluminum, airplane (Canadian Press style)",
    vocabulary: "apartment, cell phone, vacation, gas, postal code, truck, sidewalk, line-up, fall, math, washroom",
    dates: "November 15, 2026 (or 15 November 2026 when the source uses it; keep one style)",
    punctuation: "double quotation marks with commas and periods inside, as in American usage",
  },
  in: {
    label: "South Asian English (India, Pakistan)",
    spelling: "British: colour, centre, organise, analyse, travelled, defence, programme (a course or broadcast), cheque, tyre",
    vocabulary: "standard international business English, mobile (phone), petrol, flat, postcode or PIN code. No Indianisms that read as errors elsewhere (do the needful, prepone, revert back, kindly do the needful)",
    dates: "15 November 2026 (day first)",
    punctuation: "British conventions. Keep amounts as written; don't convert to lakh or crore unless the source already uses them",
  },
  neutral: {
    label: "International (neutral)",
    spelling: "whichever spelling the source uses; if it mixes them, follow the more common one consistently",
    vocabulary: "words understood everywhere: phone, fuel, holiday or vacation avoided in favour of time off or trip, apartment or flat avoided in favour of home",
    dates: "15 November 2026 (unambiguous day-month-year in words)",
    punctuation: "double quotation marks; serial comma where it avoids confusion",
  },
};

/** Prompt text for Claude: the rules for one variant. */
export function variantPrompt(id) {
  const v = VARIANTS[id] || VARIANTS.neutral;
  return `Write in ${v.label}.
- Spelling: ${v.spelling}.
- Vocabulary: ${v.vocabulary}.
- Dates: ${v.dates}.
- Punctuation: ${v.punctuation}.
- Never convert numbers, units, prices or currencies: they are facts and stay exactly as in the source.
- Product names, menu labels, quotes, file names, code and URLs keep their original spelling (a US app's "Color" menu stays "Color").`;
}

let MAPS;
/** For each variant: lowercase wrong form -> right form. */
function maps() {
  if (MAPS) return MAPS;
  MAPS = {};
  for (const [id, side] of Object.entries(SIDE)) {
    const m = new Map();
    for (const [g, list] of Object.entries(GROUPS)) {
      for (const p of list) {
        let want = side[g];
        if (want === "ca") want = CA_US_MISC.has(p.us) ? "us" : "uk";
        const [right, wrong] = want === "us" ? [p.us, p.uk] : [p.uk, p.us];
        if (right !== wrong) m.set(wrong, right);
      }
    }
    MAPS[id] = m;
  }
  return MAPS;
}

const keepCase = (src, word) => (src === src.toUpperCase() && src.length > 1 ? word.toUpperCase()
  : src[0] === src[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word);

/** Strip what must keep its own spelling: code, URLs, Markdown link targets, quoted UI labels in bold. */
function prose(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\*\*[^*\n]+\*\*/g, " ");
}

/**
 * Spellings in `text` that belong to another variant. Returns { variant, hits: [{ word, suggestion, count }],
 * mixed: true when a neutral text uses both American and British forms }. A hit with maybeName is capitalised
 * mid-sentence (Department of Defense) and is left for a person to decide; fixVariant never changes those.
 */
/** A capitalised word that doesn't start a sentence is probably a name ("Department of Defense", "Kennedy Center"). */
const SENTENCE_START = /(^|[.!?:]\s+|\n\s*|#+\s*|[-*]\s+|"|\(|\u0000\d+\u0000\s*)$/;
const midCaps = (src, i) => /^[A-Z]/.test(src[i]) && !SENTENCE_START.test(src.slice(Math.max(0, i - 12), i));

export function checkVariant(text, id) {
  const src = prose(text);
  const words = [...src.matchAll(/[A-Za-z]+/g)].map((m) => ({ w: m[0], name: midCaps(src, m.index) }));
  if (id === "neutral" || !SIDE[id]) {
    const us = maps().uk, uk = maps().us; // wrong-for-UK are American forms and the reverse
    let a = 0, b = 0;
    for (const { w, name } of words) { if (name) continue; const l = w.toLowerCase(); if (us.has(l)) a++; if (uk.has(l)) b++; }
    return { variant: "neutral", hits: [], mixed: a > 0 && b > 0, american: a, british: b };
  }
  const m = maps()[id];
  const found = new Map();
  for (const { w, name } of words) {
    const right = m.get(w.toLowerCase());
    if (!right) continue;
    const k = w.toLowerCase() + (name ? "|name" : "");
    const cur = found.get(k) || { word: w, suggestion: keepCase(w, right), count: 0, ...(name ? { maybeName: true } : {}) };
    cur.count++;
    found.set(k, cur);
  }
  return { variant: id, hits: [...found.values()].sort((x, y) => y.count - x.count) };
}

/** Replace other-variant spellings with the chosen variant's (outside code, URLs and bold labels). */
export function fixVariant(text, id) {
  const m = maps()[id];
  if (!m) return String(text || "");
  const protect = [];
  const masked = String(text || "").replace(/```[\s\S]*?```|`[^`\n]*`|\]\([^)]*\)|https?:\/\/\S+|\*\*[^*\n]+\*\*/g, (s) => {
    protect.push(s);
    return `\u0000${protect.length - 1}\u0000`;
  });
  return masked.replace(/[A-Za-z]+/g, (w, i, all) => {
    const r = m.get(w.toLowerCase());
    return r && !midCaps(all, i) ? keepCase(w, r) : w;
  })
    .replace(/\u0000(\d+)\u0000/g, (_, i) => protect[Number(i)]);
}
