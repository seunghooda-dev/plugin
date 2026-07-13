import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { validateSubtitleDocument } from "../src/subtitles";
import {
  DEFAULT_WHISPER_CUE_LIMIT,
  WhisperSubtitleImportError,
  parseWhisperJson,
  type WhisperSubtitleImportErrorCode,
} from "../src/whisper-subtitles";

// Sanitized official Whisper `--output_format json --word_timestamps True` shape.
// Base64 keeps this TypeScript fixture ASCII-only while exercising UTF-8 Korean decoding.
const WHISPER_JSON_BASE64 = "eyJ0ZXh0Ijoi7IiP7ZSM66Gc7JqwIOyKpO2KnOuUlOyYpCDsnpDrp4kg7YWM7Iqk7Yq4Iiwic2VnbWVudHMiOlt7ImlkIjowLCJzZWVrIjowLCJzdGFydCI6MC4xLCJlbmQiOjIuNCwidGV4dCI6IiDsiI/tlIzroZzsmrAg7Iqk7Yqc65SU7JikIiwidG9rZW5zIjpbMSwyXSwidGVtcGVyYXR1cmUiOjAsImF2Z19sb2dwcm9iIjotMC4xLCJjb21wcmVzc2lvbl9yYXRpbyI6MS4xLCJub19zcGVlY2hfcHJvYiI6MC4wMSwid29yZHMiOlt7IndvcmQiOiIg7IiP7ZSM66Gc7JqwIiwic3RhcnQiOjAuMTIsImVuZCI6MC44NiwicHJvYmFiaWxpdHkiOjAuOTh9LHsid29yZCI6IiDsiqTtipzrlJTsmKQiLCJzdGFydCI6MC45LCJlbmQiOjIuMzIsInByb2JhYmlsaXR5IjowLjk3fV19LHsiaWQiOjEsInNlZWsiOjI0MCwic3RhcnQiOjIuNSwiZW5kIjo0LjgsInRleHQiOiIg7J6Q66eJIO2FjOyKpO2KuCIsInRva2VucyI6WzMsNF0sInRlbXBlcmF0dXJlIjowLCJhdmdfbG9ncHJvYiI6LTAuMDgsImNvbXByZXNzaW9uX3JhdGlvIjoxLjA1LCJub19zcGVlY2hfcHJvYiI6MC4wMSwid29yZHMiOlt7IndvcmQiOiIg7J6Q66eJIiwic3RhcnQiOjIuNTYsImVuZCI6My4zMSwicHJvYmFiaWxpdHkiOjAuOTl9LHsid29yZCI6IiDthYzsiqTtirgiLCJzdGFydCI6My4zNiwiZW5kIjo0Ljc0LCJwcm9iYWJpbGl0eSI6MC45Nn1dfV0sImxhbmd1YWdlIjoia28ifQ==";

interface FixtureRecord extends Record<string, unknown> {
  segments: Array<Record<string, unknown>>;
}

function fixtureJson(): string {
  return Buffer.from(WHISPER_JSON_BASE64, "base64").toString("utf8");
}

function fixtureRecord(): FixtureRecord {
  return JSON.parse(fixtureJson()) as FixtureRecord;
}

function wordsOf(segment: Record<string, unknown>): Array<Record<string, unknown>> {
  return segment.words as Array<Record<string, unknown>>;
}

function expectImportError(
  action: () => unknown,
  code: WhisperSubtitleImportErrorCode,
): void {
  assert.throws(action, (error: unknown) => {
    return error instanceof WhisperSubtitleImportError && error.code === code;
  });
}

describe("official Whisper JSON subtitle conversion", () => {
  it("preserves UTF-8 Korean and measured cue/word timestamps", () => {
    const document = parseWhisperJson(fixtureJson(), { projectKey: "  Premiere 한국어  " });

    assert.equal(document.projectKey, "Premiere 한국어");
    assert.equal(document.cues.length, 2);
    assert.equal(document.cues[0]?.text, "숏플로우 스튜디오");
    assert.equal(document.cues[1]?.text, "자막 테스트");
    assert.deepEqual(
      document.cues[0]?.words.map(({ s, e, t }) => ({ s, e, t })),
      [
        { s: 0.12, e: 0.86, t: "숏플로우" },
        { s: 0.9, e: 2.32, t: "스튜디오" },
      ],
    );
    assert.deepEqual(
      document.cues[1]?.words.map(({ s, e, t }) => ({ s, e, t })),
      [
        { s: 2.56, e: 3.31, t: "자막" },
        { s: 3.36, e: 4.74, t: "테스트" },
      ],
    );
    assert.equal(validateSubtitleDocument(document).valid, true);
  });

  it("generates deterministic IDs that stay unique for every imported item", () => {
    const first = parseWhisperJson(fixtureJson(), { projectKey: "project-A" });
    const second = parseWhisperJson(fixtureJson(), { projectKey: "project-A" });
    assert.deepEqual(
      first.cues.map((cue) => ({
        cueId: cue.cueId,
        wordIds: cue.words.map((word) => word.wordId),
      })),
      second.cues.map((cue) => ({
        cueId: cue.cueId,
        wordIds: cue.words.map((word) => word.wordId),
      })),
    );

    const ids = first.cues.flatMap((cue) => [cue.cueId, ...cue.words.map((word) => word.wordId)]);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("rejects malformed JSON and missing word-timestamp schema", () => {
    expectImportError(() => parseWhisperJson("{"), "INVALID_JSON");
    expectImportError(() => parseWhisperJson("{}"), "INVALID_SCHEMA");
    expectImportError(() => parseWhisperJson('{"segments":[]}'), "INVALID_SCHEMA");

    const missingWords = fixtureRecord();
    delete missingWords.segments[0]!.words;
    expectImportError(() => parseWhisperJson(JSON.stringify(missingWords)), "INVALID_SCHEMA");

    const emptyWord = fixtureRecord();
    wordsOf(emptyWord.segments[0]!)[0]!.word = "   ";
    expectImportError(() => parseWhisperJson(JSON.stringify(emptyWord)), "INVALID_SCHEMA");
  });

  it("rejects non-finite, reversed, negative, and out-of-cue timestamps", () => {
    const nonFinite = fixtureJson().replace('"end":2.4', '"end":1e309');
    expectImportError(() => parseWhisperJson(nonFinite), "INVALID_TIME");

    const reversedSegment = fixtureRecord();
    reversedSegment.segments[0]!.end = 0.05;
    expectImportError(() => parseWhisperJson(JSON.stringify(reversedSegment)), "INVALID_TIME");

    const negativeWord = fixtureRecord();
    wordsOf(negativeWord.segments[0]!)[0]!.start = -0.1;
    expectImportError(() => parseWhisperJson(JSON.stringify(negativeWord)), "INVALID_TIME");

    const reversedWord = fixtureRecord();
    wordsOf(reversedWord.segments[0]!)[0]!.end = 0.11;
    expectImportError(() => parseWhisperJson(JSON.stringify(reversedWord)), "INVALID_TIME");

    const outsideCue = fixtureRecord();
    wordsOf(outsideCue.segments[0]!)[1]!.end = 2.41;
    expectImportError(() => parseWhisperJson(JSON.stringify(outsideCue)), "INVALID_TIME");
  });

  it("rejects unsorted segment and word timelines instead of silently reordering them", () => {
    const unsortedSegments = fixtureRecord();
    unsortedSegments.segments.reverse();
    expectImportError(() => parseWhisperJson(JSON.stringify(unsortedSegments)), "UNSORTED_TIMESTAMPS");

    const unsortedWords = fixtureRecord();
    wordsOf(unsortedWords.segments[0]!).reverse();
    expectImportError(() => parseWhisperJson(JSON.stringify(unsortedWords)), "UNSORTED_TIMESTAMPS");
  });

  it("enforces input, cue, word, and text size limits before editor import", () => {
    const source = fixtureJson();
    expectImportError(
      () => parseWhisperJson(source, { maxInputChars: source.length - 1 }),
      "LIMIT_EXCEEDED",
    );
    expectImportError(() => parseWhisperJson(source, { maxCueCount: 1 }), "LIMIT_EXCEEDED");
    expectImportError(() => parseWhisperJson(source, { maxWordsPerCue: 1 }), "LIMIT_EXCEEDED");
    expectImportError(() => parseWhisperJson(source, { maxTotalWords: 3 }), "LIMIT_EXCEEDED");
    expectImportError(() => parseWhisperJson(source, { maxTotalTextChars: 10 }), "LIMIT_EXCEEDED");
    expectImportError(() => parseWhisperJson(source, { maxCueCount: 0 }), "INVALID_SCHEMA");
  });
});

describe("Whisper JSON edge cases and schema hardening", () => {
  it("rejects non-string input before parsing", () => {
    expectImportError(() => parseWhisperJson(123 as unknown as string), "INVALID_SCHEMA");
    expectImportError(() => parseWhisperJson(null as unknown as string), "INVALID_SCHEMA");
  });

  it("strips a leading UTF-8 BOM from the whole document before JSON.parse", () => {
    const bom = String.fromCharCode(0xfeff);
    const document = parseWhisperJson(`${bom}${fixtureJson()}`, { projectKey: "bom" });
    assert.equal(document.cues.length, 2);
    assert.equal(validateSubtitleDocument(document).valid, true);
  });

  it("rejects a segments value that is present but not an array", () => {
    expectImportError(() => parseWhisperJson('{"segments":{}}'), "INVALID_SCHEMA");
    expectImportError(() => parseWhisperJson('{"segments":"nope"}'), "INVALID_SCHEMA");
  });

  it("rejects a segment that is not an object", () => {
    const notObject = fixtureRecord();
    (notObject.segments as unknown[])[0] = 42;
    expectImportError(() => parseWhisperJson(JSON.stringify(notObject)), "INVALID_SCHEMA");
  });

  it("rejects non-string and blank segment text", () => {
    const numberText = fixtureRecord();
    numberText.segments[0]!.text = 5;
    expectImportError(() => parseWhisperJson(JSON.stringify(numberText)), "INVALID_SCHEMA");

    const blankText = fixtureRecord();
    blankText.segments[0]!.text = "   ";
    expectImportError(() => parseWhisperJson(JSON.stringify(blankText)), "INVALID_SCHEMA");
  });

  it("rejects a non-numeric segment start or end", () => {
    const stringStart = fixtureRecord();
    stringStart.segments[0]!.start = "0.1";
    expectImportError(() => parseWhisperJson(JSON.stringify(stringStart)), "INVALID_TIME");
  });

  it("rejects an empty words array with the missing-timestamp schema error", () => {
    const emptyWords = fixtureRecord();
    emptyWords.segments[0]!.words = [];
    expectImportError(() => parseWhisperJson(JSON.stringify(emptyWords)), "INVALID_SCHEMA");
  });

  it("rejects a word entry that is not an object", () => {
    const badWord = fixtureRecord();
    (wordsOf(badWord.segments[0]!) as unknown[])[0] = 42;
    expectImportError(() => parseWhisperJson(JSON.stringify(badWord)), "INVALID_SCHEMA");
  });

  it("rejects non-numeric, non-finite, and zero-duration word times", () => {
    const stringStart = fixtureRecord();
    wordsOf(stringStart.segments[0]!)[0]!.start = "0.12";
    expectImportError(() => parseWhisperJson(JSON.stringify(stringStart)), "INVALID_TIME");

    const infiniteStart = fixtureJson().replace('"start":0.12', '"start":1e309');
    expectImportError(() => parseWhisperJson(infiniteStart), "INVALID_TIME");

    const zeroDuration = fixtureRecord();
    const firstWord = wordsOf(zeroDuration.segments[0]!)[0]!;
    firstWord.end = firstWord.start;
    expectImportError(() => parseWhisperJson(JSON.stringify(zeroDuration)), "INVALID_TIME");
  });

  it("rejects a word that starts before its parent segment", () => {
    const earlyWord = fixtureRecord();
    wordsOf(earlyWord.segments[0]!)[0]!.start = 0.05;
    expectImportError(() => parseWhisperJson(JSON.stringify(earlyWord)), "INVALID_TIME");
  });

  it("accepts adjacent words that share a start time when the end time does not regress", () => {
    const equalStart = fixtureRecord();
    const words = wordsOf(equalStart.segments[0]!);
    words[1]!.start = words[0]!.start;
    const document = parseWhisperJson(JSON.stringify(equalStart));
    assert.equal(document.cues[0]?.words.length, 2);
    assert.equal(validateSubtitleDocument(document).valid, true);
  });

  it("rejects limit options that are above range or non-integer", () => {
    const source = fixtureJson();
    expectImportError(
      () => parseWhisperJson(source, { maxCueCount: DEFAULT_WHISPER_CUE_LIMIT + 1 }),
      "INVALID_SCHEMA",
    );
    expectImportError(() => parseWhisperJson(source, { maxWordsPerCue: 1.5 }), "INVALID_SCHEMA");
  });
});
