import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { normalizeSpeechSegments, planSilenceCuts, recommendPunchCues } from "../src/automation";
import {
  resolveAutomationTranscript,
  speechControllerTranscriptToAutomationTranscript,
  subtitleDocumentToAutomationTranscript,
} from "../src/automation-transcript";
import type { SpeechControllerTranscript } from "../src/speech-controller";
import type { SubtitleDocument } from "../src/subtitles";
import { parseSrt } from "../src/subtitles";

const ROOT = path.resolve(__dirname, "../..");

function documentFixture(): SubtitleDocument {
  return {
    version: 1,
    projectKey: "project-A",
    cues: [
      {
        cueId: "cue-1",
        start: 0.5,
        end: 1.2,
        text: "원본 텍스트",
        enabled: true,
        hidden: false,
        words: [
          { wordId: "word-1", s: 0.5, e: 0.8, t: "보이는", hidden: false },
          { wordId: "word-2", s: 0.8, e: 1.2, t: "단어", hidden: false },
        ],
      },
      {
        cueId: "cue-2",
        start: 2,
        end: 3,
        text: "숨긴 큐",
        enabled: true,
        hidden: true,
        words: [],
      },
      {
        cueId: "cue-3",
        start: 3.5,
        end: 4.5,
        text: "단어 없는 큐",
        enabled: true,
        hidden: false,
        words: [],
      },
      {
        cueId: "cue-4",
        start: 5,
        end: 6,
        text: "비활성 큐",
        enabled: false,
        hidden: false,
        words: [],
      },
    ],
  };
}

describe("subtitleDocumentToAutomationTranscript", () => {
  it("turns visible subtitle cues into automation transcript segments", () => {
    const transcript = subtitleDocumentToAutomationTranscript(documentFixture());
    assert.ok(transcript);
    assert.equal(transcript.name, "자막: project-A");
    assert.equal(transcript.duration, 4.5);
    assert.deepEqual(transcript.segments, [
      { start: 0.5, end: 1.2, text: "보이는 단어" },
      { start: 3.5, end: 4.5, text: "단어 없는 큐" },
    ]);
  });

  it("returns null when no visible timed subtitle text remains", () => {
    const document = documentFixture();
    document.cues.forEach((cue) => {
      cue.enabled = false;
    });
    assert.equal(subtitleDocumentToAutomationTranscript(document), null);
  });

  it("falls back to raw cue text when every word is hidden or blank", () => {
    const document: SubtitleDocument = {
      version: 1,
      projectKey: "fallback",
      cues: [{
        cueId: "cue-1",
        start: 1,
        end: 2,
        text: "폴백 텍스트",
        enabled: true,
        hidden: false,
        words: [
          { wordId: "word-1", s: 1, e: 1.5, t: "숨김", hidden: true },
          { wordId: "word-2", s: 1.5, e: 2, t: "   ", hidden: false },
        ],
      }],
    };
    const transcript = subtitleDocumentToAutomationTranscript(document);
    assert.deepEqual(transcript?.segments, [{ start: 1, end: 2, text: "폴백 텍스트" }]);
  });

  it("joins only visible words and trims their spacing", () => {
    const document: SubtitleDocument = {
      version: 1,
      projectKey: "visible-words",
      cues: [{
        cueId: "cue-1",
        start: 0,
        end: 1,
        text: "원본",
        enabled: true,
        hidden: false,
        words: [
          { wordId: "word-1", s: 0, e: 0.4, t: "  보이는  ", hidden: false },
          { wordId: "word-2", s: 0.4, e: 0.7, t: "숨김", hidden: true },
          { wordId: "word-3", s: 0.7, e: 1, t: "단어", hidden: false },
        ],
      }],
    };
    const transcript = subtitleDocumentToAutomationTranscript(document);
    assert.deepEqual(transcript?.segments, [{ start: 0, end: 1, text: "보이는 단어" }]);
  });

  it("drops zero-length, reversed, and whitespace-only cues", () => {
    const document: SubtitleDocument = {
      version: 1,
      projectKey: "degenerate",
      cues: [
        { cueId: "cue-1", start: 2, end: 2, text: "길이 없음", enabled: true, hidden: false, words: [] },
        { cueId: "cue-2", start: 3, end: 2.5, text: "역행", enabled: true, hidden: false, words: [] },
        { cueId: "cue-3", start: 4, end: 5, text: "   ", enabled: true, hidden: false, words: [] },
      ],
    };
    assert.equal(subtitleDocumentToAutomationTranscript(document), null);
  });

  it("produces segments that survive automation normalization unchanged", () => {
    const transcript = subtitleDocumentToAutomationTranscript(documentFixture());
    assert.ok(transcript);
    assert.deepEqual(normalizeSpeechSegments(transcript.segments, transcript.duration), transcript.segments);
  });
});

describe("resolveAutomationTranscript", () => {
  it("prefers live STT results over the SRT fallback", () => {
    const speech: SpeechControllerTranscript = {
      name: "live-stt",
      duration: 9,
      result: {
        text: "라이브 STT",
        srt: "1\n00:00:01,000 --> 00:00:02,000\n라이브 STT\n",
        model: "gpt-4o-mini-transcribe",
        segments: [{ start: 1, end: 2, text: "라이브 STT" }],
      },
    };
    assert.deepEqual(speechControllerTranscriptToAutomationTranscript(speech), {
      name: "live-stt",
      duration: 9,
      segments: [{ start: 1, end: 2, text: "라이브 STT" }],
    });
    assert.deepEqual(resolveAutomationTranscript(speech, documentFixture()), {
      name: "live-stt",
      duration: 9,
      segments: [{ start: 1, end: 2, text: "라이브 STT" }],
    });
  });

  it("falls back to the current subtitle document when STT is absent", () => {
    const transcript = resolveAutomationTranscript(null, documentFixture());
    assert.equal(transcript?.name, "자막: project-A");
    assert.equal(transcript?.segments.length, 2);
  });

  it("returns null when neither source can produce a transcript", () => {
    assert.equal(resolveAutomationTranscript(null, null), null);
    assert.equal(resolveAutomationTranscript(undefined, undefined), null);
    assert.equal(resolveAutomationTranscript(null, { version: 1, projectKey: "empty", cues: [] }), null);
  });
});

describe("Premiere Host automation fixture", () => {
  it("contains real silence gaps and emphasis for both cut and punch smoke gates", () => {
    const source = readFileSync(
      path.join(ROOT, "tests", "shortflow_automation_gap.srt"),
      "utf8",
    );
    const document = parseSrt(source, { projectKey: "host-automation-gap" });
    const transcript = subtitleDocumentToAutomationTranscript(document);
    assert.ok(transcript);

    const cutPlan = planSilenceCuts(transcript.segments, 6.03, {
      minSilence: 0.42,
      padding: 0.08,
      trimLeading: true,
      trimTrailing: true,
    });
    const punches = recommendPunchCues(transcript.segments, 6.03, {
      keywords: ["ShortFlow", "중요", "핵심"],
      maximumCues: 12,
    });

    assert.ok(cutPlan.cuts.length >= 2, `expected at least two silence cuts, received ${cutPlan.cuts.length}`);
    assert.ok(cutPlan.cuts.every((cut) => cut.end > cut.start && cut.duration >= 0.12));
    assert.ok(punches.length >= 2, `expected at least two punch cues, received ${punches.length}`);
    assert.ok(punches.some((cue) => cue.text.includes("중요")));
    assert.ok(punches.some((cue) => cue.text.includes("ShortFlow")));
  });
});
