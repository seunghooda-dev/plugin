import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_SUBTITLE_SERIALIZED_JSON_CHARS,
  SUBTITLE_AUTOSAVE_SCHEMA,
  SUBTITLE_DOCUMENT_VERSION,
  SUBTITLE_UNDO_LIMIT,
  SubtitleUndoRedo,
  buildSrt,
  cloneSubtitleDocument,
  createSubtitleDocument,
  deserializeSubtitleAutosave,
  deserializeSubtitleDocument,
  editSubtitleWord,
  findActiveSubtitle,
  joinSubtitleWords,
  mergeSubtitleCues,
  normalizeSubtitleDocument,
  parseSrt,
  reflowSubtitleCues,
  secondsToSrtTime,
  serializeSubtitleAutosave,
  serializeSubtitleDocument,
  setSubtitleCueEnabled,
  setSubtitleCueHidden,
  setSubtitleWordHidden,
  splitSubtitleCue,
  srtTimeToSeconds,
  subtitleAutosaveKey,
  subtitleSeekTime,
  validateSubtitleDocument,
  type SubtitleCue,
  type SubtitleDocument,
} from "../src/subtitles";

function cue(overrides: Partial<SubtitleCue> = {}): SubtitleCue {
  return {
    cueId: "cue-1",
    start: 1,
    end: 5,
    text: "안녕하세요 반갑습니다",
    enabled: true,
    hidden: false,
    words: [
      { wordId: "word-1", s: 1, e: 2.2, t: "안녕하세요", hidden: false },
      { wordId: "word-2", s: 2.5, e: 4.8, t: "반갑습니다", hidden: false },
    ],
    ...overrides,
  };
}

function documentWith(...cues: SubtitleCue[]): SubtitleDocument {
  return {
    version: SUBTITLE_DOCUMENT_VERSION,
    projectKey: "project-A",
    cues,
  };
}

describe("subtitle document normalization and validation", () => {
  it("creates a versioned project document", () => {
    const document = createSubtitleDocument("  Premiere Project  ");
    assert.equal(document.version, 1);
    assert.equal(document.projectKey, "Premiere Project");
    assert.deepEqual(document.cues, []);
  });

  it("normalizes line endings, invalid times, and booleans", () => {
    const document = normalizeSubtitleDocument({
      projectKey: "p",
      cues: [{ start: -4, end: -1, text: "  첫 줄\r\n둘째 줄  ", enabled: false, hidden: true }],
    });
    assert.equal(document.cues[0]?.start, 0);
    assert.equal(document.cues[0]?.end, 0.001);
    assert.equal(document.cues[0]?.text, "첫 줄\n둘째 줄");
    assert.equal(document.cues[0]?.enabled, false);
    assert.equal(document.cues[0]?.hidden, true);
  });

  it("generates deterministic stable cue and word IDs", () => {
    const input = { projectKey: "p", cues: [{ start: 1, end: 3, text: "하나 둘" }] };
    const first = normalizeSubtitleDocument(input);
    const second = normalizeSubtitleDocument(input);
    assert.equal(first.cues[0]?.cueId, second.cues[0]?.cueId);
    assert.deepEqual(first.cues[0]?.words.map((word) => word.wordId), second.cues[0]?.words.map((word) => word.wordId));
  });

  it("keeps supplied IDs and resolves duplicates deterministically", () => {
    const document = normalizeSubtitleDocument({
      projectKey: "p",
      cues: [
        { cueId: "same", start: 0, end: 1, text: "A" },
        { cueId: "same", start: 1, end: 2, text: "B" },
      ],
    });
    assert.deepEqual(document.cues.map((item) => item.cueId), ["same", "same~2"]);
  });

  it("sorts cues chronologically without mutating input", () => {
    const input = {
      projectKey: "p",
      cues: [
        { cueId: "late", start: 5, end: 6, text: "나중" },
        { cueId: "early", start: 1, end: 2, text: "먼저" },
      ],
    };
    const document = normalizeSubtitleDocument(input);
    assert.deepEqual(document.cues.map((item) => item.cueId), ["early", "late"]);
    assert.equal(input.cues[0]?.cueId, "late");
  });

  it("reports malformed documents and duplicate IDs", () => {
    const result = validateSubtitleDocument({
      version: 99,
      projectKey: "",
      cues: [
        { cueId: "x", start: 2, end: 1, text: 3, words: [] },
        { cueId: "x", start: 1, end: 2, text: "ok", words: [] },
      ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.code === "UNSUPPORTED_VERSION"));
    assert.ok(result.issues.some((issue) => issue.code === "DUPLICATE_CUE_ID"));
    assert.ok(result.issues.some((issue) => issue.code === "INVALID_TIME"));
  });

  it("reports words outside their cue", () => {
    const value = documentWith(cue({
      words: [{ wordId: "outside", s: 0, e: 3, t: "밖", hidden: false }],
    }));
    const result = validateSubtitleDocument(value);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.code === "WORD_OUTSIDE_CUE"));
  });
});

describe("immutable word and cue editing", () => {
  it("edits one word while preserving IDs and the original document", () => {
    const original = documentWith(cue());
    const edited = editSubtitleWord(original, "cue-1", "word-2", "환영합니다");
    assert.equal(edited.cues[0]?.text, "안녕하세요 환영합니다");
    assert.equal(edited.cues[0]?.words[1]?.wordId, "word-2");
    assert.equal(original.cues[0]?.text, "안녕하세요 반갑습니다");
    assert.notEqual(edited.cues, original.cues);
  });

  it("splits a multi-token edit across the original word timing", () => {
    const edited = editSubtitleWord(documentWith(cue()), "cue-1", "word-2", "정말 반갑습니다");
    const words = edited.cues[0]?.words ?? [];
    assert.deepEqual(words.map((word) => word.t), ["안녕하세요", "정말", "반갑습니다"]);
    assert.equal(words[1]?.wordId, "word-2");
    assert.equal(words[1]?.s, 2.5);
    assert.equal(words[2]?.e, 4.8);
  });

  it("deletes a word and removes the cue when its final word is deleted", () => {
    const oneWord = documentWith(cue({
      text: "하나",
      words: [{ wordId: "only", s: 1, e: 5, t: "하나", hidden: false }],
    }));
    assert.deepEqual(editSubtitleWord(oneWord, "cue-1", "only", "").cues, []);
  });

  it("hides and unhides a word while rebuilding output text", () => {
    const original = documentWith(cue());
    const hidden = setSubtitleWordHidden(original, "cue-1", "word-1", true);
    assert.equal(hidden.cues[0]?.text, "반갑습니다");
    assert.equal(hidden.cues[0]?.words[0]?.hidden, true);
    const shown = setSubtitleWordHidden(hidden, "cue-1", "word-1", false);
    assert.equal(shown.cues[0]?.text, "안녕하세요 반갑습니다");
  });

  it("joins adjacent words without whitespace and spans both timings", () => {
    const joined = joinSubtitleWords(documentWith(cue()), "cue-1", "word-1", "word-2");
    assert.equal(joined.cues[0]?.words.length, 1);
    assert.equal(joined.cues[0]?.words[0]?.t, "안녕하세요반갑습니다");
    assert.equal(joined.cues[0]?.words[0]?.s, 1);
    assert.equal(joined.cues[0]?.words[0]?.e, 4.8);
    assert.equal(joined.cues[0]?.words[0]?.wordId, "word-1");
  });

  it("rejects joining non-adjacent words", () => {
    const three = cue({
      text: "하나 둘 셋",
      words: [
        { wordId: "a", s: 1, e: 2, t: "하나", hidden: false },
        { wordId: "b", s: 2, e: 3, t: "둘", hidden: false },
        { wordId: "c", s: 3, e: 4, t: "셋", hidden: false },
      ],
    });
    assert.throws(() => joinSubtitleWords(documentWith(three), "cue-1", "a", "c"), /인접/u);
  });

  it("rejects joining words with different hidden states without mutating the source", () => {
    const source = documentWith(cue({
      text: "표시 숨김",
      words: [
        { wordId: "shown", s: 1, e: 2, t: "표시", hidden: false },
        { wordId: "hidden", s: 2, e: 3, t: "숨김", hidden: true },
      ],
    }));
    const snapshot = cloneSubtitleDocument(source);
    assert.throws(
      () => joinSubtitleWords(source, "cue-1", "shown", "hidden"),
      /숨김 상태가 다른 단어/u,
    );
    assert.deepEqual(source, snapshot);
  });

  it("keeps a joined pair hidden so excluded words cannot leak into SRT", () => {
    const source = documentWith(cue({
      text: "비공개 내용 공개",
      words: [
        { wordId: "private-1", s: 1, e: 2, t: "비공개", hidden: true },
        { wordId: "private-2", s: 2, e: 3, t: "내용", hidden: true },
        { wordId: "public", s: 3, e: 4, t: "공개", hidden: false },
      ],
    }));
    const joined = joinSubtitleWords(source, "cue-1", "private-1", "private-2");
    assert.equal(joined.cues[0]?.words[0]?.hidden, true);
    assert.equal(joined.cues[0]?.words[0]?.wordId, "private-1");
    assert.equal(buildSrt(joined).includes("비공개내용"), false);
    assert.match(buildSrt(joined), /공개/u);
  });

  it("toggles cue enabled and hidden states immutably", () => {
    const original = documentWith(cue());
    const disabled = setSubtitleCueEnabled(original, "cue-1", false);
    const hidden = setSubtitleCueHidden(disabled, "cue-1", true);
    assert.equal(hidden.cues[0]?.enabled, false);
    assert.equal(hidden.cues[0]?.hidden, true);
    assert.equal(original.cues[0]?.enabled, true);
  });
});

describe("cue split, merge, and max-character reflow", () => {
  it("splits at the selected word's measured timestamp", () => {
    const result = splitSubtitleCue(documentWith(cue()), "cue-1", "word-2");
    assert.equal(result.cues.length, 2);
    assert.equal(result.cues[0]?.end, 2.5);
    assert.equal(result.cues[1]?.start, 2.5);
    assert.equal(result.cues[0]?.text, "안녕하세요");
    assert.equal(result.cues[1]?.text, "반갑습니다");
    assert.equal(result.cues[0]?.cueId, "cue-1");
    assert.match(result.cues[1]?.cueId ?? "", /^cue-1~split/u);
    assert.equal(result.cues[1]?.words[0]?.wordId, "word-2");
  });

  it("falls back to non-whitespace character proportions", () => {
    const noMeasuredWords = cue({
      start: 0,
      end: 10,
      text: "가나다 라",
      words: [],
    });
    const result = splitSubtitleCue(documentWith(noMeasuredWords), "cue-1", { charIndex: 3 });
    assert.equal(result.cues[0]?.text, "가나다");
    assert.equal(result.cues[1]?.text, "라");
    assert.equal(result.cues[0]?.end, 7.5);
  });

  it("does not mutate the source while splitting", () => {
    const original = documentWith(cue());
    splitSubtitleCue(original, "cue-1", "word-2");
    assert.equal(original.cues.length, 1);
    assert.equal(original.cues[0]?.end, 5);
  });

  it("merges adjacent cues and preserves the leading cue ID and word IDs", () => {
    const first = cue({ cueId: "first", start: 0, end: 2, text: "첫째" });
    const second = cue({
      cueId: "second",
      start: 2.2,
      end: 4,
      text: "둘째",
      words: [{ wordId: "second-word", s: 2.2, e: 4, t: "둘째", hidden: false }],
    });
    const merged = mergeSubtitleCues(documentWith(first, second), "first", "second");
    assert.equal(merged.cues.length, 1);
    assert.equal(merged.cues[0]?.cueId, "first");
    assert.equal(merged.cues[0]?.text, "첫째 둘째");
    assert.ok(merged.cues[0]?.words.some((word) => word.wordId === "second-word"));
  });

  it("rejects merging non-adjacent cues", () => {
    const cues = [
      cue({ cueId: "a", start: 0, end: 1 }),
      cue({ cueId: "b", start: 1, end: 2 }),
      cue({ cueId: "c", start: 2, end: 3 }),
    ];
    assert.throws(() => mergeSubtitleCues(documentWith(...cues), "a", "c"), /인접/u);
  });

  it("rejects merging cues with different visibility states without mutating the source", () => {
    const first = cue({ cueId: "first", start: 1, end: 5, enabled: true, hidden: false });
    const disabled = cue({ cueId: "disabled", start: 5, end: 9, enabled: false, hidden: false });
    const hidden = cue({ cueId: "hidden", start: 5, end: 9, enabled: true, hidden: true });
    for (const second of [disabled, hidden]) {
      const source = documentWith(first, second);
      const snapshot = cloneSubtitleDocument(source);
      assert.throws(
        () => mergeSubtitleCues(source, "first", second.cueId),
        /표시 상태가 다른 자막 큐/u,
      );
      assert.deepEqual(source, snapshot);
    }
  });

  it("preserves matching excluded cue states after merge", () => {
    const firstDisabled = cue({ cueId: "disabled-1", enabled: false });
    const secondDisabled = cue({ cueId: "disabled-2", start: 5, end: 9, enabled: false });
    const disabled = mergeSubtitleCues(documentWith(firstDisabled, secondDisabled), "disabled-1", "disabled-2");
    assert.equal(disabled.cues[0]?.enabled, false);
    assert.equal(buildSrt(disabled), "");

    const firstHidden = cue({ cueId: "hidden-1", hidden: true });
    const secondHidden = cue({ cueId: "hidden-2", start: 5, end: 9, hidden: true });
    const hidden = mergeSubtitleCues(documentWith(firstHidden, secondHidden), "hidden-1", "hidden-2");
    assert.equal(hidden.cues[0]?.hidden, true);
    assert.equal(buildSrt(hidden), "");
  });

  it("keeps IDs, time ranges, and source documents stable across split and merge", () => {
    const original = documentWith(cue());
    const snapshot = cloneSubtitleDocument(original);
    const split = splitSubtitleCue(original, "cue-1", "word-2");
    const merged = mergeSubtitleCues(split, split.cues[0]!.cueId, split.cues[1]!.cueId);
    assert.equal(validateSubtitleDocument(split).valid, true);
    assert.equal(validateSubtitleDocument(merged).valid, true);
    assert.equal(merged.cues[0]?.cueId, "cue-1");
    assert.deepEqual(merged.cues[0]?.words.map((word) => word.wordId), ["word-1", "word-2"]);
    assert.ok(merged.cues[0]?.words.every((word) =>
      word.s >= (merged.cues[0]?.start ?? 0) && word.e <= (merged.cues[0]?.end ?? 0) && word.e > word.s));
    assert.deepEqual(original, snapshot);
  });

  it("reflows measured words at maxChars and uses their timings", () => {
    const source = cue({
      start: 0,
      end: 6,
      text: "하나 둘 셋 넷",
      words: [
        { wordId: "a", s: 0, e: 1, t: "하나", hidden: false },
        { wordId: "b", s: 1.2, e: 2.2, t: "둘", hidden: false },
        { wordId: "c", s: 3, e: 4, t: "셋", hidden: false },
        { wordId: "d", s: 4.5, e: 6, t: "넷", hidden: false },
      ],
    });
    const result = reflowSubtitleCues(documentWith(source), 5);
    assert.deepEqual(result.cues.map((item) => item.text), ["하나 둘", "셋 넷"]);
    assert.equal(result.cues[0]?.start, 0);
    assert.equal(result.cues[0]?.end, 2.2);
    assert.equal(result.cues[1]?.start, 3);
    assert.equal(result.cues[1]?.end, 6);
    assert.equal(result.cues[0]?.cueId, "cue-1");
  });

  it("uses character weights when reflow has no measured word timing", () => {
    const source = cue({
      start: 0,
      end: 10,
      text: "가나다라 마",
      words: [],
    });
    const result = reflowSubtitleCues(documentWith(source), 4);
    assert.deepEqual(result.cues.map((item) => item.text), ["가나다라", "마"]);
    assert.equal(result.cues[0]?.end, 8);
    assert.equal(result.cues[1]?.start, 8);
  });

  it("hard-splits a word longer than maxChars", () => {
    const source = cue({
      start: 0,
      end: 4,
      text: "가나다라마바사",
      words: [{ wordId: "long", s: 0, e: 4, t: "가나다라마바사", hidden: false }],
    });
    const result = reflowSubtitleCues(documentWith(source), 3);
    assert.deepEqual(result.cues.map((item) => item.text), ["가나다", "라마바", "사"]);
    assert.ok(result.cues.every((item) => item.text.length <= 3));
  });

  it("keeps existing word IDs stable when reflow derives split-word IDs", () => {
    const source = cue({
      start: 0,
      end: 4,
      text: "가나다라마 바",
      words: [
        { wordId: "word", s: 0, e: 3, t: "가나다라마", hidden: false },
        { wordId: "word~2", s: 3, e: 4, t: "바", hidden: false },
      ],
    });
    const result = reflowSubtitleCues(documentWith(source), 3);
    const wordIds = result.cues.flatMap((item) => item.words.map((word) => word.wordId));
    assert.equal(wordIds.filter((wordId) => wordId === "word~2").length, 1);
    assert.equal(new Set(wordIds).size, wordIds.length);
    assert.ok(wordIds.includes("word"));
  });

  it("keeps reflowed cue and word ranges valid when source word timings overlap", () => {
    const source = cue({
      start: 0,
      end: 4,
      text: "하나 둘 셋 넷",
      words: [
        { wordId: "a", s: 0, e: 1.8, t: "하나", hidden: false },
        { wordId: "b", s: 1, e: 2.5, t: "둘", hidden: false },
        { wordId: "c", s: 2, e: 3.2, t: "셋", hidden: false },
        { wordId: "d", s: 3, e: 4, t: "넷", hidden: false },
      ],
    });
    const result = reflowSubtitleCues(documentWith(source), 5);
    assert.equal(validateSubtitleDocument(result).valid, true);
    assert.ok(result.cues.every((item, index) => index === 0 || item.start >= (result.cues[index - 1]?.end ?? 0)));
  });

  it("rejects a reflow that cannot fit positive-duration cues", () => {
    const source = cue({
      start: 0,
      end: 0.002,
      text: "하나 둘 셋",
      words: [
        { wordId: "a", s: 0, e: 0.001, t: "하나", hidden: false },
        { wordId: "b", s: 0.001, e: 0.0015, t: "둘", hidden: false },
        { wordId: "c", s: 0.0015, e: 0.002, t: "셋", hidden: false },
      ],
    });
    assert.throws(() => reflowSubtitleCues(documentWith(source), 2), /너무 짧/u);
  });

  it("leaves disabled and hidden cues unchanged during reflow", () => {
    const disabled = cue({ enabled: false, text: "아주 긴 비활성 자막입니다" });
    const result = reflowSubtitleCues(documentWith(disabled), 4);
    assert.equal(result.cues.length, 1);
    assert.equal(result.cues[0]?.text, disabled.text);
  });

  it("does not split or expose a long hidden word during reflow", () => {
    const source = documentWith(cue({
      start: 0,
      end: 10,
      text: "절대로노출하면안되는내용 공개",
      words: [
        { wordId: "private", s: 0, e: 8, t: "절대로노출하면안되는내용", hidden: true },
        { wordId: "public", s: 8, e: 10, t: "공개", hidden: false },
      ],
    }));
    const result = reflowSubtitleCues(source, 2, { maxOutputCues: 1 });
    assert.equal(result.cues.length, 1);
    assert.equal(result.cues[0]?.words.filter((word) => word.wordId === "private").length, 1);
    assert.equal(result.cues[0]?.words[0]?.t, "절대로노출하면안되는내용");
    assert.doesNotMatch(buildSrt(result), /절대로/u);
    assert.match(buildSrt(result), /공개/u);
  });

  it("enforces an optional total output cue cap before returning excessive reflow output", () => {
    const source = documentWith(cue({
      start: 0,
      end: 10,
      text: "가나다라마바사아자차",
      words: [{ wordId: "long", s: 0, e: 10, t: "가나다라마바사아자차", hidden: false }],
    }));
    const snapshot = cloneSubtitleDocument(source);
    assert.throws(
      () => reflowSubtitleCues(source, 2, { maxOutputCues: 4 }),
      /출력 큐 상한 4개/u,
    );
    assert.deepEqual(source, snapshot);

    const exact = reflowSubtitleCues(source, 2, { maxOutputCues: 5 });
    assert.equal(exact.cues.length, 5);
    assert.equal(validateSubtitleDocument(exact).valid, true);
    assert.deepEqual(source, snapshot);
  });

  it("rejects invalid reflow output caps while keeping the legacy call signature", () => {
    const source = documentWith(cue());
    assert.throws(() => reflowSubtitleCues(source, 5, { maxOutputCues: 0 }), /안전한 정수/u);
    assert.throws(() => reflowSubtitleCues(source, 5, { maxOutputCues: 1.5 }), /안전한 정수/u);
    assert.ok(reflowSubtitleCues(source, 5).cues.length > 0);
  });
});

describe("SRT parsing and building", () => {
  it("formats timestamps with millisecond rollover", () => {
    assert.equal(secondsToSrtTime(59.9996), "00:01:00,000");
    assert.equal(secondsToSrtTime(-1), "00:00:00,000");
  });

  it("parses comma, dot, and minute-only timestamps", () => {
    assert.equal(srtTimeToSeconds("00:01:02,500"), 62.5);
    assert.equal(srtTimeToSeconds("01:02.250"), 62.25);
    assert.equal(srtTimeToSeconds("bad"), null);
  });

  it("parses BOM, CRLF, optional indices, multiline text, and cue settings", () => {
    const source = "\uFEFF1\r\n00:00:01,000 --> 00:00:02,500 position:50%\r\n첫 줄\r\n둘째 줄\r\n\r\n00:03.000 --> 00:04.000\r\n다음";
    const document = parseSrt(source, { projectKey: "srt-project" });
    assert.equal(document.projectKey, "srt-project");
    assert.equal(document.cues.length, 2);
    assert.equal(document.cues[0]?.text, "첫 줄\n둘째 줄");
    assert.equal(document.cues[1]?.start, 3);
    assert.ok((document.cues[0]?.words.length ?? 0) > 0);
  });

  it("skips malformed and reversed cues", () => {
    const source = "1\nnot a time\ninvalid\n\n2\n00:00:03,000 --> 00:00:02,000\nreverse";
    assert.deepEqual(parseSrt(source).cues, []);
  });

  it("rejects oversized SRT input before parsing", () => {
    assert.throws(() => parseSrt("가".repeat(11), { maxInputChars: 10 }), /SRT 입력/u);
  });

  it("caps imported SRT cue count and total subtitle text", () => {
    const one = "1\n00:00:00,000 --> 00:00:01,000\n하나";
    const two = "2\n00:00:01,000 --> 00:00:02,000\n둘";
    assert.throws(() => parseSrt(`${one}\n\n${two}`, { maxCueCount: 1 }), /최대 1개/u);
    assert.throws(() => parseSrt(one, { maxTotalTextChars: 1 }), /텍스트/u);
  });

  it("builds sequential SRT while omitting disabled and hidden cues", () => {
    const document = documentWith(
      cue({ cueId: "shown", start: 1, end: 2, text: "표시" }),
      cue({ cueId: "disabled", start: 2, end: 3, text: "비활성", enabled: false }),
      cue({ cueId: "hidden", start: 3, end: 4, text: "숨김", hidden: true }),
    );
    const output = buildSrt(document);
    assert.match(output, /^1\n00:00:01,000 --> 00:00:02,000\n표시\n$/u);
    assert.doesNotMatch(output, /비활성|숨김/u);
  });

  it("does not leak hidden words into SRT even when raw cue text still contains them", () => {
    const source = cue({
      text: "보이기 숨기기",
      words: [
        { wordId: "shown", s: 1, e: 2, t: "보이기", hidden: false },
        { wordId: "hidden", s: 2, e: 3, t: "숨기기", hidden: true },
      ],
    });
    const output = buildSrt(documentWith(source));
    assert.match(output, /보이기/u);
    assert.doesNotMatch(output, /숨기기/u);
  });

  it("can include disabled and hidden cues explicitly", () => {
    const document = documentWith(
      cue({ cueId: "disabled", enabled: false }),
      cue({ cueId: "hidden", start: 6, end: 8, hidden: true }),
    );
    const output = buildSrt(document, { includeDisabled: true, includeHidden: true });
    assert.match(output, /^1\n/u);
    assert.match(output, /\n2\n/u);
  });

  it("round-trips valid SRT timing and text", () => {
    const original = documentWith(cue({ start: 1.234, end: 5.678, text: "왕복 테스트" }));
    const parsed = parseSrt(buildSrt(original), { projectKey: "project-A" });
    assert.equal(parsed.cues[0]?.start, 1.234);
    assert.equal(parsed.cues[0]?.end, 5.678);
    assert.equal(parsed.cues[0]?.text, "왕복 테스트");
  });
});

describe("playhead lookup and word seek", () => {
  it("tracks the latest measured word at the current playhead", () => {
    const document = documentWith(cue());
    assert.deepEqual(findActiveSubtitle(document, 1.5), {
      cueId: "cue-1",
      cueIndex: 0,
      wordId: "word-1",
      wordIndex: 0,
    });
    assert.equal(findActiveSubtitle(document, 3)?.wordId, "word-2");
    assert.equal(findActiveSubtitle(document, 5), null);
  });

  it("ignores disabled, hidden, and invalid-time lookups", () => {
    const document = documentWith(cue({ enabled: false }));
    assert.equal(findActiveSubtitle(document, 2), null);
    assert.equal(findActiveSubtitle(document, Number.NaN), null);
  });

  it("uses character-weighted progress when measured timings are absent", () => {
    const document = documentWith(cue({
      start: 0,
      end: 10,
      text: "가나다라 마",
      words: [
        { wordId: "long", s: Number.NaN, e: Number.NaN, t: "가나다라", hidden: false },
        { wordId: "short", s: Number.NaN, e: Number.NaN, t: "마", hidden: false },
      ],
    }));
    assert.equal(findActiveSubtitle(document, 6)?.wordId, "long");
    assert.equal(findActiveSubtitle(document, 9)?.wordId, "short");
  });

  it("returns exact word start for click-to-seek and cue start otherwise", () => {
    const document = documentWith(cue());
    assert.equal(subtitleSeekTime(document, "cue-1", "word-2"), 2.5);
    assert.equal(subtitleSeekTime(document, "cue-1"), 1);
    assert.throws(() => subtitleSeekTime(document, "cue-1", "missing"), /찾을 수 없습니다/u);
  });
});

describe("serialization, project autosave, and undo/redo", () => {
  it("deep-clones documents", () => {
    const original = documentWith(cue());
    const cloned = cloneSubtitleDocument(original);
    cloned.cues[0]!.words[0]!.t = "변경";
    assert.equal(original.cues[0]?.words[0]?.t, "안녕하세요");
  });

  it("serializes and restores a versioned document", () => {
    const original = documentWith(cue());
    const restored = deserializeSubtitleDocument(serializeSubtitleDocument(original), "project-A");
    assert.deepEqual(restored, original);
  });

  it("rejects invalid JSON, versions, and project mismatches", () => {
    assert.throws(() => deserializeSubtitleDocument("{"), /JSON/u);
    assert.throws(() => deserializeSubtitleDocument('{"version":2,"projectKey":"p","cues":[]}'), /버전/u);
    assert.throws(() => deserializeSubtitleDocument(serializeSubtitleDocument(documentWith()), "other"), /프로젝트/u);
  });

  it("strictly rejects repairable but malformed saved document schemas", () => {
    const malformed = {
      version: SUBTITLE_DOCUMENT_VERSION,
      projectKey: "project-A",
      cues: [{
        cueId: "",
        start: -1,
        end: -2,
        text: 123,
        enabled: "yes",
        hidden: 0,
        words: "not-an-array",
      }],
    };
    assert.throws(
      () => deserializeSubtitleDocument(JSON.stringify(malformed), "project-A"),
      /형식이 올바르지 않습니다: cues\[0\]/u,
    );
    assert.throws(
      () => deserializeSubtitleDocument(JSON.stringify({ version: 1, projectKey: "project-A" }), "project-A"),
      /cues는 배열/u,
    );

    const wrongBoolean = JSON.parse(serializeSubtitleDocument(documentWith(cue()))) as {
      cues: Array<{ enabled: unknown }>;
    };
    wrongBoolean.cues[0]!.enabled = "true";
    assert.throws(
      () => deserializeSubtitleDocument(JSON.stringify(wrongBoolean), "project-A"),
      /enabled와 hidden은 불리언/u,
    );

    const duplicateIds = JSON.parse(serializeSubtitleDocument(documentWith(cue()))) as SubtitleDocument;
    duplicateIds.cues.push(cloneSubtitleDocument(duplicateIds).cues[0]!);
    assert.throws(
      () => deserializeSubtitleDocument(JSON.stringify(duplicateIds), "project-A"),
      /cueId가 중복/u,
    );
  });

  it("rejects oversized saved JSON before parsing", () => {
    const oversized = " ".repeat(MAX_SUBTITLE_SERIALIZED_JSON_CHARS + 1);
    assert.throws(() => deserializeSubtitleDocument(oversized), /JSON이 안전 제한/u);
    assert.throws(() => deserializeSubtitleAutosave(oversized, "project-A"), /JSON이 안전 제한/u);
  });

  it("does not normalize away corruption while serializing documents or autosaves", () => {
    const corrupted = documentWith(cue());
    corrupted.cues[0]!.enabled = "true" as unknown as boolean;
    assert.throws(() => serializeSubtitleDocument(corrupted), /형식이 올바르지 않습니다/u);
    assert.throws(() => serializeSubtitleAutosave(corrupted), /형식이 올바르지 않습니다/u);
  });

  it("strictly rejects unsorted cue and word timelines instead of silently reordering them", () => {
    const unsortedCues = createSubtitleDocument("project-A", [
      { cueId: "first", start: 1, end: 2, text: "첫째" },
      { cueId: "second", start: 3, end: 4, text: "둘째" },
    ]);
    unsortedCues.cues.reverse();
    assert.ok(validateSubtitleDocument(unsortedCues).issues.some((issue) => issue.code === "UNSORTED_CUES"));
    assert.throws(() => serializeSubtitleAutosave(unsortedCues), /정렬/u);

    const unsortedWords = documentWith(cue());
    unsortedWords.cues[0]!.words.reverse();
    assert.ok(validateSubtitleDocument(unsortedWords).issues.some((issue) => issue.code === "UNSORTED_WORDS"));
    assert.throws(() => serializeSubtitleDocument(unsortedWords), /정렬/u);
  });

  it("builds deterministic, project-specific autosave keys", () => {
    const first = subtitleAutosaveKey("프로젝트 A");
    assert.equal(first, subtitleAutosaveKey("프로젝트 A"));
    assert.notEqual(first, subtitleAutosaveKey("프로젝트 B"));
    assert.match(first, /^shortflow\.subtitles\.v1\./u);
  });

  it("wraps autosaves with a schema and enforces the project key", () => {
    const original = documentWith(cue());
    const serialized = serializeSubtitleAutosave(original);
    const envelope = JSON.parse(serialized) as { schema: string; version: number };
    assert.equal(envelope.schema, SUBTITLE_AUTOSAVE_SCHEMA);
    assert.equal(envelope.version, 1);
    assert.deepEqual(deserializeSubtitleAutosave(serialized, "project-A"), original);
    assert.throws(() => deserializeSubtitleAutosave(serialized, "project-B"), /프로젝트/u);
  });

  it("strictly rejects corrupted autosave documents and envelope/document key mismatches", () => {
    const envelope = JSON.parse(serializeSubtitleAutosave(documentWith(cue()))) as {
      projectKey: unknown;
      document: SubtitleDocument;
    };
    envelope.document.cues[0]!.words[0]!.s = -10;
    assert.throws(
      () => deserializeSubtitleAutosave(JSON.stringify(envelope), "project-A"),
      /자동 저장 자막 문서 형식이 올바르지 않습니다/u,
    );

    const wrongDocumentKey = JSON.parse(serializeSubtitleAutosave(documentWith(cue()))) as {
      document: SubtitleDocument;
    };
    wrongDocumentKey.document.projectKey = "other";
    assert.throws(
      () => deserializeSubtitleAutosave(JSON.stringify(wrongDocumentKey), "project-A"),
      /자동 저장 자막 문서가 현재 프로젝트와 일치하지 않습니다/u,
    );

    const wrongEnvelopeKey = JSON.parse(serializeSubtitleAutosave(documentWith(cue()))) as {
      projectKey: unknown;
    };
    wrongEnvelopeKey.projectKey = 42;
    assert.throws(
      () => deserializeSubtitleAutosave(JSON.stringify(wrongEnvelopeKey), "project-A"),
      /projectKey가 유효하지 않습니다/u,
    );
  });

  it("supports undo, redo, and clears redo after a new commit", () => {
    const initial = documentWith(cue());
    const history = new SubtitleUndoRedo(initial);
    history.commit(setSubtitleCueEnabled(initial, "cue-1", false));
    assert.equal(history.current.cues[0]?.enabled, false);
    assert.equal(history.undo().cues[0]?.enabled, true);
    assert.equal(history.redo().cues[0]?.enabled, false);
    history.undo();
    history.commit(setSubtitleCueHidden(initial, "cue-1", true));
    assert.equal(history.canRedo, false);
  });

  it("caps history at 50 entries even when a larger depth is requested", () => {
    const initial = documentWith(cue());
    const history = new SubtitleUndoRedo(initial, 500);
    for (let index = 0; index < 75; index += 1) {
      const current = history.current;
      current.cues[0]!.text = `편집 ${index}`;
      history.commit(current);
    }
    assert.equal(history.maxDepth, SUBTITLE_UNDO_LIMIT);
    assert.equal(history.undoDepth, SUBTITLE_UNDO_LIMIT);
  });

  it("returns defensive copies from history", () => {
    const history = new SubtitleUndoRedo(documentWith(cue()));
    const exposed = history.current;
    exposed.cues[0]!.text = "외부 변경";
    assert.equal(history.current.cues[0]?.text, "안녕하세요 반갑습니다");
  });

  it("rejects commits from another project", () => {
    const history = new SubtitleUndoRedo(documentWith(cue()));
    assert.throws(() => history.commit({ ...documentWith(cue()), projectKey: "other" }), /다른 프로젝트/u);
  });
});
