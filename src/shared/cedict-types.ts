/**
 * CC-CEDICT data shapes shared by the loader, lookup, and consumers.
 *
 * One source line in cedict_ts.u8 looks like:
 *   中國 中国 [Zhong1 guo2] /China/Middle Kingdom/
 *
 * Parsed into a CedictEntry, that line becomes:
 *   { traditional: "中國", simplified: "中国",
 *     pinyinNumeric: "Zhong1 guo2", definitions: ["China", "Middle Kingdom"] }
 *
 * A single headword (e.g. 行) can have multiple entries with different pinyin,
 * which is why CedictHit returns an array.
 */

export interface CedictEntry {
  traditional: string;
  simplified: string;
  /** Raw pinyin in CC-CEDICT's numeric form, e.g. "yin2 hang2". */
  pinyinNumeric: string;
  /** One slash-delimited gloss per array slot. */
  definitions: string[];
}

export interface CedictHit {
  /** The matched substring (always the simplified headword we keyed on). */
  word: string;
  /** Length of the matched word in characters (= word.length). */
  length: number;
  /** All dictionary entries with this headword (homographs). */
  entries: CedictEntry[];
}
