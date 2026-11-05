/**
 * Estimated on-screen width of a title link or snippet in Google's desktop results.
 * Google renders title links in Arial ~20 px and snippets in Arial ~14 px and truncates them to fit the
 * result width (title links and snippets docs), so a pixel estimate predicts a cut better than a character
 * count: "WWW" and "iii" are both 3 characters. Widths are Arial/Helvetica advance widths in 1/1000 em
 * (identical to the Helvetica AFM metrics); unknown characters count as an average letter (556).
 * Crawlers such as Screaming Frog use the same idea with limits of 561 px (title) and 985 px (description).
 */
const ASCII = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]; // U+0020..U+007E
const EXTRA = { "’": 222, "‘": 222, "“": 333, "”": 333, "–": 556, "—": 1000, "…": 1000, "·": 333, " ": 278 };

export const TITLE_PX = 561; // desktop title link width used by common crawlers (Arial 20 px)
export const DESC_PX = 985; // desktop snippet width used by common crawlers (Arial 14 px)

/** Width in px of `text` set in Arial at `size` px. */
export function textWidth(text, size) {
  let units = 0;
  for (const ch of String(text || "")) {
    const c = ch.codePointAt(0);
    units += c >= 32 && c <= 126 ? ASCII[c - 32] : EXTRA[ch] ?? 556;
  }
  return Math.round((units * size) / 1000);
}

export const titleWidth = (t) => textWidth(t, 20);
export const descWidth = (d) => textWidth(d, 14);
