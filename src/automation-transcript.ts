import type { AutomationTranscript } from "./automation-controller";
import type { SpeechControllerTranscript } from "./speech-controller";
import type { SubtitleCue, SubtitleDocument, SubtitleWord } from "./subtitles";

export const SUBTITLE_AUTOMATION_TRANSCRIPT_PREFIX = "자막";

function visibleWords(cue: SubtitleCue): SubtitleWord[] {
  return cue.words.filter((word) => !word.hidden && word.t.trim());
}

function visibleCueText(cue: SubtitleCue): string {
  const words = visibleWords(cue);
  if (words.length > 0) return words.map((word) => word.t.trim()).filter(Boolean).join(" ").trim();
  return cue.text.trim();
}

export function subtitleDocumentToAutomationTranscript(document: SubtitleDocument): AutomationTranscript | null {
  const segments = document.cues
    .filter((cue) => cue.enabled && !cue.hidden && cue.end > cue.start)
    .map((cue) => ({
      start: cue.start,
      end: cue.end,
      text: visibleCueText(cue),
    }))
    .filter((segment) => segment.text.length > 0);

  if (segments.length === 0) return null;
  return {
    name: `${SUBTITLE_AUTOMATION_TRANSCRIPT_PREFIX}: ${document.projectKey}`,
    duration: Math.max(...segments.map((segment) => segment.end)),
    segments,
  };
}

export function speechControllerTranscriptToAutomationTranscript(
  transcript: SpeechControllerTranscript,
): AutomationTranscript {
  return {
    name: transcript.name,
    duration: transcript.duration,
    segments: transcript.result.segments,
  };
}

export function resolveAutomationTranscript(
  speechTranscript: SpeechControllerTranscript | null | undefined,
  subtitleDocument: SubtitleDocument | null | undefined,
): AutomationTranscript | null {
  if (speechTranscript) return speechControllerTranscriptToAutomationTranscript(speechTranscript);
  return subtitleDocument ? subtitleDocumentToAutomationTranscript(subtitleDocument) : null;
}
