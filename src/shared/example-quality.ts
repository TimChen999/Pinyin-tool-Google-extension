/**
 * Quality gate for captured example sentences attached to vocab entries.
 *
 * The page context that the content script captures around a "+ Vocab"
 * click is often noisy on the open web -- button labels, breadcrumbs,
 * one-word fragments, OCR cruft, URLs, etc. Storing those uncritically
 * would pollute the vocab card and the flashcard flip face. This module
 * scores each candidate sentence on a 0-100 scale and the service
 * worker only persists candidates that meet MIN_SENTENCE_QUALITY_SCORE.
 *
 * The rubric is intentionally simple and additive so it's easy to
 * reason about and test. Tune MIN_SENTENCE_QUALITY_SCORE in
 * shared/constants.ts to be stricter or more permissive without
 * touching the scoring logic itself.
 */

import { MIN_SENTENCE_QUALITY_SCORE } from "./constants";

/** Single CJK Unified Ideograph (basic + Extension A), global. */
const HAN_CHAR_GLOBAL = /[\u4e00-\u9fff\u3400-\u4dbf]/g;

/** Matches an http(s) URL anywhere in the string. */
const URL_PATTERN = /https?:\/\//i;

/** Common boilerplate / breadcrumb characters that hint at UI chrome. */
const UI_NOISE_PATTERN = /[|>]/;

/** Pure digits / punctuation / whitespace -- never a usable example. */
const PURE_NUMERIC = /^[\d.,\s]+$/;

/** Sentence ends with a CJK or ASCII terminator. */
const TERMINATOR_AT_END = /[\u3002\uff01\uff1f.!?]\s*$/;

/** Has any sentence terminator anywhere in the string. */
const TERMINATOR_ANYWHERE = /[\u3002\uff01\uff1f.!?]/;

/**
 * Scores a captured sentence against the vocab target word on a 0-100
 * scale. The score is the clamped sum of independent signals so each
 * factor's contribution is readable in isolation.
 *
 *   Hard zeros (returns 0 immediately):
 *     - empty / whitespace-only
 *     - identical to the target
 *     - pure digits / punctuation
 *     - shorter than target.length + 3 (no real surrounding text)
 *
 *   Penalties:
 *     -30  contains an http(s) URL
 *     -10  contains pipe / greater-than (UI / breadcrumb hint)
 *
 *   Bonuses:
 *     +30  ends with a sentence terminator
 *     +15  terminator anywhere in the string (not at the end)
 *     +25  length 8-40 chars (the example-sentence sweet spot)
 *     +20  length 41-80 chars
 *     +10  length 81-150 chars
 *     -10  length > 150 chars (passage-shaped, not example-shaped)
 *     +25  Han character count >= target.length + 4
 *     +10  Han character count >= target.length + 2
 *     +10  contains the target verbatim
 *
 * The result is then clamped to [0, 100].
 */
export function scoreSentence(target: string, sentence: string): number {
  if (!target || !sentence) return 0;
  const trimmed = sentence.trim();
  if (!trimmed) return 0;
  if (trimmed === target) return 0;
  if (PURE_NUMERIC.test(trimmed)) return 0;

  const len = trimmed.length;
  if (len < target.length + 3) return 0;

  let score = 0;

  if (URL_PATTERN.test(trimmed)) score -= 30;
  if (UI_NOISE_PATTERN.test(trimmed)) score -= 10;

  if (TERMINATOR_AT_END.test(trimmed)) {
    score += 30;
  } else if (TERMINATOR_ANYWHERE.test(trimmed)) {
    score += 15;
  }

  if (len >= 8 && len <= 40) score += 25;
  else if (len <= 80) score += 20;
  else if (len <= 150) score += 10;
  else score -= 10;

  const han = (trimmed.match(HAN_CHAR_GLOBAL) ?? []).length;
  if (han >= target.length + 4) score += 25;
  else if (han >= target.length + 2) score += 10;

  if (trimmed.includes(target)) score += 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Returns true when the captured sentence clears
 * MIN_SENTENCE_QUALITY_SCORE and should be persisted as a vocab
 * example. Service worker callers gate every captured context through
 * this before pushing into the vocab store.
 */
export function isUsableExample(target: string, sentence: string): boolean {
  return scoreSentence(target, sentence) >= MIN_SENTENCE_QUALITY_SCORE;
}

// ─── Length trimming ───────────────────────────────────────────────

/** Comfortable upper bound (~12-15 Chinese words once delimiters factor in). */
const EXAMPLE_SOFT_LIMIT = 40;

/** Absolute ceiling -- the target's own clause is itself trimmed past this. */
const EXAMPLE_HARD_LIMIT = 80;

/** Mid-sentence pause delimiters used to chop a long sentence into clauses. */
const CLAUSE_DELIM_RE = /([，、；,;])/;

/** Trailing clause-only delimiter -- stripped so trimmed output doesn't end on a dangling comma. */
const TRAILING_CLAUSE_DELIM_RE = /[，、；,;]\s*$/;

/**
 * Trims a long captured sentence so the stored example reads like one
 * thought, not a paragraph. Preserves the original sentence when it's
 * already under EXAMPLE_SOFT_LIMIT.
 *
 * Strategy:
 *   1. Split on clause-level delimiters (，、；,;) while keeping each
 *      delimiter attached to its preceding clause.
 *   2. Locate the clause containing the target word.
 *   3. Greedy-expand outward from that clause, picking the shorter
 *      neighbour first to keep the trim balanced, until adding any
 *      adjacent clause would push the result past EXAMPLE_SOFT_LIMIT.
 *   4. If the target's own clause is itself over EXAMPLE_HARD_LIMIT
 *      (e.g. an unpunctuated wall of text), centre-cut around the
 *      target so the stored snippet still fits.
 *   5. Strip a dangling trailing comma so the output doesn't read
 *      like a sentence fragment.
 *
 * Service worker callers run this *after* the quality gate -- the
 * gate measures the original captured context, the trimmer just
 * shortens what gets persisted.
 */
export function trimSentenceForExample(sentence: string, target: string): string {
  const s = sentence.trim();
  if (s.length <= EXAMPLE_SOFT_LIMIT) return s;

  const clauses = splitIntoClauses(s);
  if (clauses.length === 0) {
    return centerCutAroundTarget(s, target, EXAMPLE_HARD_LIMIT);
  }

  const targetIdx = target ? clauses.findIndex((c) => c.includes(target)) : -1;
  if (targetIdx < 0) {
    // Target not present in any clause -- fall back to a centred slice
    // of the original string (or, when the target is genuinely missing,
    // a leading hard cut). Either way we never exceed EXAMPLE_HARD_LIMIT.
    return centerCutAroundTarget(s, target, EXAMPLE_HARD_LIMIT);
  }

  let left = targetIdx;
  let right = targetIdx;
  let acc = clauses[targetIdx];

  if (acc.length > EXAMPLE_HARD_LIMIT) {
    return stripTrailingClauseDelim(centerCutAroundTarget(acc, target, EXAMPLE_HARD_LIMIT));
  }

  while (left > 0 || right < clauses.length - 1) {
    const canL = left > 0;
    const canR = right < clauses.length - 1;
    const lLen = canL ? clauses[left - 1].length : Infinity;
    const rLen = canR ? clauses[right + 1].length : Infinity;
    // Pick the shorter neighbour so the trim stays roughly balanced
    // around the target. Tie -> expand right (forward continuation
    // tends to read more naturally in Chinese).
    const expandRight = canR && (!canL || rLen <= lLen);
    const candidate = expandRight ? acc + clauses[right + 1] : clauses[left - 1] + acc;
    if (candidate.length > EXAMPLE_SOFT_LIMIT) break;
    acc = candidate;
    if (expandRight) right += 1;
    else left -= 1;
  }

  return stripTrailingClauseDelim(acc);
}

function splitIntoClauses(text: string): string[] {
  const tokens = text.split(CLAUSE_DELIM_RE);
  const clauses: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok) continue;
    if (CLAUSE_DELIM_RE.test(tok) && tok.length === 1) {
      // A bare delimiter -- attach to the previous clause if any.
      if (clauses.length > 0) clauses[clauses.length - 1] += tok;
      // If a delimiter leads (rare), drop it.
    } else {
      clauses.push(tok);
    }
  }
  return clauses;
}

function centerCutAroundTarget(text: string, target: string, budget: number): string {
  if (text.length <= budget) return text.trim();
  const idx = target ? text.indexOf(target) : -1;
  if (idx < 0) return text.slice(0, budget).trim();
  const half = Math.max(0, Math.floor((budget - target.length) / 2));
  const start = Math.max(0, idx - half);
  const end = Math.min(text.length, idx + target.length + half);
  return text.slice(start, end).trim();
}

function stripTrailingClauseDelim(text: string): string {
  return text.replace(TRAILING_CLAUSE_DELIM_RE, "").trim();
}
