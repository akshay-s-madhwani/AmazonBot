/**
 * WANTED COUPONS. A Reward row's `coupons` cell lists, one per line, the
 * coupons worth collecting as "<first number>-<second number>":
 *
 *   50-250     "₹50 off on orders of ₹250"
 *   50-        any coupon whose first number is 50 (or whose only number is)
 *   -250       any coupon whose second number is 250 (or whose only number is)
 *   5%-100     "5% off up to ₹100" — a % is part of the number
 *
 * The dash is a separator, never a minus sign. A blank cell wants any coupon.
 */

export interface WantedCoupon {
  /** The line as written in the sheet (spaces removed) — what "Found coupons" records. */
  text: string;
  first: string;
  second: string;
}

/** "₹1,000" -> "1000", "5 %" -> "5%", "50.00" -> "50". */
function normaliseNumber(raw: string): string {
  const pct = /%/.test(raw);
  const n = Number(raw.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && raw.replace(/[^\d]/g, "") !== "" ? `${n}${pct ? "%" : ""}` : "";
}

export function parseWantedCoupons(cell: string): WantedCoupon[] {
  const out: WantedCoupon[] = [];
  for (const line of cell.split(/\r?\n|;/)) {
    const text = line.replace(/\s+/g, "");
    if (!text) continue;
    // The first dash-like character splits the two sides.
    const at = text.search(/[-–—]/);
    const [l, r] = at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at + 1)];
    const first = normaliseNumber(l);
    const second = normaliseNumber(r);
    if (first || second) out.push({ text, first, second });
  }
  return out;
}

/**
 * The numbers a coupon's description states, in order. Money and percents
 * ("₹50", "Rs. 250", "5%") are what a coupon is about; bare numbers (dates,
 * "Pick 3 of 14") count only when the text has no money or percent at all.
 */
export function couponNumbers(description: string): string[] {
  const text = description.replace(/\s+/g, " ");
  const anchored: string[] = [];
  const money = /(?:₹|\brs\.?|\binr)\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*%/gi;
  for (const m of text.matchAll(money)) {
    const n = m[1] !== undefined ? normaliseNumber(m[1]) : normaliseNumber(`${m[2]}%`);
    if (n) anchored.push(n);
  }
  if (anchored.length) return anchored;
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => normaliseNumber(m[0])).filter(Boolean);
}

/** The wanted line this coupon satisfies, or null. */
export function matchCoupon(numbers: string[], wanted: WantedCoupon[]): WantedCoupon | null {
  for (const w of wanted) {
    if (numbers.length >= 2) {
      if ((!w.first || w.first === numbers[0]) && (!w.second || w.second === numbers[1])) return w;
    } else if (numbers.length === 1) {
      // One number can only satisfy a one-sided line, on either side.
      const only = w.first || w.second;
      if (!(w.first && w.second) && only === numbers[0]) return w;
    }
  }
  return null;
}

/** How a coupon is shown in notes: "50-250", "5%-100", "50". */
export function describeCoupon(numbers: string[]): string {
  return numbers.length ? numbers.slice(0, 2).join("-") : "?";
}
