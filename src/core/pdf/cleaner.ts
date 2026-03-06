/**
 * cleanExtractedText
 * ------------------
 * Remove common garbage patterns that pdf-parse produces when processing
 * slide-based PDFs (PowerPoint-style, Impress, Keynote exported to PDF).
 *
 * Root causes of garbage text from slide PDFs:
 *  1. Absolute positioning — pdf-parse loses the spaces between words that were
 *     placed in separate absolutely-positioned text boxes, producing run-together
 *     tokens like "1AccountingFramework:objectives,componentsoftheannual".
 *  2. Copyright watermarks — professors embed a copyright footer on every slide,
 *     so the same "©Author, PhD" string is repeated ~30-50 times in the extraction.
 *  3. Slide-number / header / footer fragments — single digits, dashes, or very
 *     short all-caps strings that add no informational value.
 *
 * This cleaner makes the text usable as a fallback when the Gemini Files API
 * (native PDF vision) path is unavailable or fails.
 */

/** Return true when a single whitespace-delimited token looks like fused content. */
function isFusedToken(token: string): boolean {
  // Long tokens with no internal spaces that are not URLs or plain numbers
  if (token.length <= 28) return false;
  if (/^https?:\/\//.test(token)) return false; // URL — keep
  if (/^\d+$/.test(token)) return false;         // Pure number — keep
  return true;
}

/**
 * Attempt to recover word boundaries in a fused CamelCase/mixed token.
 * e.g. "1AccountingFramework" → "1 Accounting Framework"
 *      "STRUCTUREOFTHESPANISHACCOUNTINGPLAN" → left as-is (pure caps, too ambiguous)
 */
function recoverSpacing(token: string): string {
  // Insert space before an uppercase letter that follows a lowercase letter
  let out = token.replace(/([a-z])([A-Z])/g, "$1 $2");
  // Insert space between a digit and an uppercase letter
  out = out.replace(/(\d)([A-Z])/g, "$1 $2");
  // Insert space before a run of capitals followed by a lowercase letter
  out = out.replace(/([A-Z]{2,})([A-Z][a-z])/g, "$1 $2");
  return out;
}

export function cleanExtractedText(raw: string): string {
  if (!raw) return "";

  const lines = raw.split("\n");
  const cleaned: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    // ── 1. Remove copyright / watermark lines ─────────────────────────────────
    // Match the © symbol in multiple encodings, or the word "copyright"
    if (/©|©|\(c\)\s+\d{4}|copyright\s+\d{4}/i.test(line)) continue;
    // Lines that start with © are always watermarks
    if (line.startsWith("©") || line.startsWith("©")) continue;

    // ── 2. Remove pure slide/page/section number lines ────────────────────────
    // e.g. "3", "  12  ", "- 7 -", "Page 3 of 12"
    if (/^[\d\s\-\/\.]+$/.test(line) && line.length < 15) continue;
    if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(line)) continue;
    if (/^slide\s+\d+$/i.test(line)) continue;

    // ── 3. Handle fused tokens ────────────────────────────────────────────────
    const tokens = line.split(/\s+/);
    const fusedTokens = tokens.filter(isFusedToken);
    const fusedRatio = fusedTokens.length / Math.max(tokens.length, 1);

    // Drop lines that are PREDOMINANTLY fused (>55% of tokens are fused)
    if (fusedRatio > 0.55) continue;

    // Partially fused: recover spacing in individual tokens
    const recovered = tokens
      .map((t) => (isFusedToken(t) ? recoverSpacing(t) : t))
      .join(" ");

    // ── 4. Drop very short all-caps fragments (slide sub-headings / codes) ────
    // e.g. "DEBITCREDIT", "+Assets=-Assets", "SGAP"
    if (recovered.length < 35 && recovered === recovered.toUpperCase() && /[A-Z]{3,}/.test(recovered)) continue;

    // ── 5. Drop lines containing only punctuation / accounting operators ──────
    if (/^[\+\-=\s\d\.\,\;\:\(\)\/\%\&]+$/.test(recovered) && recovered.length < 30) continue;

    cleaned.push(recovered);
  }

  // Collapse more than two consecutive blank lines
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Heuristic: return true when extracted text looks like garbage slide content
 * (high proportion of fused tokens, lots of ©, etc.).  Used to decide whether
 * to skip the text path entirely and rely on the native PDF vision path.
 */
export function isGarbageText(text: string): boolean {
  if (!text || text.trim().length < 100) return true;
  const sample = text.slice(0, 3000);
  const tokens = sample.split(/\s+/);
  if (tokens.length === 0) return true;
  const fusedCount = tokens.filter(isFusedToken).length;
  const copyrightCount = (sample.match(/©|©/g) ?? []).length;
  // Garbage if: >20% fused tokens OR copyright appears 3+ times in first 3k chars
  return fusedCount / tokens.length > 0.20 || copyrightCount >= 3;
}
