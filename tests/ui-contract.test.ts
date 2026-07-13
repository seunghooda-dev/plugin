import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings";

type Attributes = Readonly<Record<string, string>>;

interface StaticElement {
  readonly tag: string;
  readonly attributes: Attributes;
  readonly index: number;
  readonly source: string;
}

interface StaticDocument {
  readonly html: string;
  readonly elements: readonly StaticElement[];
  readonly byId: ReadonlyMap<string, readonly StaticElement[]>;
}

const ROOT = path.resolve(__dirname, "../..");
const PUBLIC_HTML_PATH = path.join(ROOT, "public", "index.html");
const PUBLIC_CSS_PATH = path.join(ROOT, "public", "styles.css");
const DIST_HTML_PATH = path.join(ROOT, "dist", "index.html");
const DIST_CSS_PATH = path.join(ROOT, "dist", "styles.css");

const LABELABLE_TAGS = new Set([
  "button",
  "input",
  "meter",
  "output",
  "progress",
  "select",
  "textarea",
]);

const FEATURE_IDS = {
  finalQc: [
    "final-qc-gate",
    "final-qc-platform-select",
    "final-qc-output-name",
    "final-qc-true-peak",
    "final-qc-clipped-samples",
    "final-qc-longest-silence",
    "final-qc-dialogue-lufs",
    "final-qc-bgm-lufs",
    "final-qc-missing-fonts",
    "final-qc-missing-assets",
    "final-qc-summary",
    "final-qc-run-btn",
    "final-qc-results",
    "final-qc-waiver-code",
    "final-qc-waiver-reason",
    "final-qc-waive-btn",
    "final-qc-json-btn",
    "final-qc-md-btn",
  ],
  assetRights: [
    "asset-rights-status",
    "asset-rights-selected-name",
    "asset-rights-kind-select",
    "asset-rights-commercial-select",
    "asset-rights-source-input",
    "asset-rights-license-input",
    "asset-rights-expiry-input",
    "asset-rights-attribution-input",
    "asset-rights-notes-input",
    "asset-rights-save-btn",
    "asset-audio-preview",
    "asset-category-select",
    "open-asset-category-btn",
  ],
  aiQueue: [
    "ai-queue-pause-btn",
    "ai-cache-clear-btn",
    "ai-queue-usage",
    "ai-cache-count",
    "ai-queue-concurrency-input",
    "ai-request-limit-input",
    "ai-cost-limit-input",
    "ai-confirm-threshold-input",
    "ai-queue-save-btn",
    "ai-job-list",
  ],
  brandKit: [
    "brand-kit-count",
    "brand-kit-import-btn",
    "brand-kit-export-btn",
    "brand-kit-select",
    "brand-kit-new-btn",
    "brand-kit-duplicate-btn",
    "brand-kit-delete-btn",
    "brand-name-input",
    "brand-font-input",
    "brand-font-weight-input",
    "brand-primary-color",
    "brand-secondary-color",
    "brand-accent-color",
    "brand-logo-name",
    "brand-logo-btn",
    "brand-caption-max-input",
    "brand-caption-position-select",
    "brand-caption-shadow-checkbox",
    "brand-caption-highlight-checkbox",
    "brand-thumb-layout-select",
    "brand-thumb-background-color",
    "brand-thumb-text-color",
    "brand-thumb-brightness-input",
    "brand-thumb-contrast-input",
    "brand-thumb-saturation-input",
    "brand-thumb-shadow-input",
    "brand-thumb-shadow-color",
    "brand-thumb-glow-input",
    "brand-thumb-glow-color",
    "brand-tts-model-select",
    "brand-tts-voice-input",
    "brand-tts-speed-input",
    "brand-active-name",
    "brand-kit-save-btn",
    "brand-kit-apply-btn",
  ],
  subtitles: [
    "subtitle-editor",
    "subtitle-editor-heading",
    "subtitle-status",
    "subtitle-import-btn",
    "subtitle-export-btn",
    "subtitle-undo-btn",
    "subtitle-redo-btn",
    "subtitle-max-chars-input",
    "subtitle-reflow-btn",
    "subtitle-ai-reflow-btn",
    "subtitle-ai-review-btn",
    "subtitle-translate-language-input",
    "subtitle-ai-translate-btn",
    "subtitle-meta",
    "subtitle-cue-list",
  ],
} as const;

const OPERATIONAL_UI_IDS = [
  "recovery-count",
  "recovery-list",
  "recovery-confirm-dialog",
  "recovery-confirm-title",
  "recovery-confirm-description",
  "recovery-confirm-label",
  "recovery-confirm-cancel-btn",
  "recovery-confirm-approve-btn",
  "run-diagnostics-btn",
  "export-diagnostics-btn",
  "diagnostics-summary",
  "diagnostics-list",
] as const;

function parseAttributes(source: string): Attributes {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function parseDocument(source: string): StaticDocument {
  const html = source.replace(/<!--[\s\S]*?-->/g, "");
  const elements: StaticElement[] = [];
  const pattern = /<([a-z][a-z0-9:-]*)(\s[^<>]*?)?\s*\/?>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = match[1]?.toLowerCase();
    if (!tag || match.index === undefined) continue;
    elements.push({
      tag,
      attributes: parseAttributes(match[2] ?? ""),
      index: match.index,
      source: match[0],
    });
  }

  const mutableById = new Map<string, StaticElement[]>();
  for (const element of elements) {
    const id = element.attributes.id;
    if (!id) continue;
    const matches = mutableById.get(id) ?? [];
    matches.push(element);
    mutableById.set(id, matches);
  }

  return { html, elements, byId: mutableById };
}

function documentFromFile(filePath: string): StaticDocument {
  return parseDocument(readFileSync(filePath, "utf8"));
}

function elementById(document: StaticDocument, id: string): StaticElement {
  const matches = document.byId.get(id) ?? [];
  assert.equal(matches.length, 1, `#${id} must occur exactly once (found ${matches.length})`);
  return matches[0]!;
}

function hasAttribute(element: StaticElement, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(element.attributes, name);
}

function classNames(element: StaticElement): ReadonlySet<string> {
  return new Set((element.attributes.class ?? "").split(/\s+/).filter(Boolean));
}

function visibleText(source: string): string {
  return source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function tokenCount(source: string, token: string): number {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(new RegExp(`\\b${escaped}\\b`, "g"))].length;
}

function optionsFor(document: StaticDocument, selectId: string): readonly StaticElement[] {
  const select = elementById(document, selectId);
  assert.equal(select.tag, "select", `#${selectId} must be a select`);
  const openEnd = document.html.indexOf(">", select.index);
  const closeStart = document.html.toLowerCase().indexOf("</select>", openEnd);
  assert.ok(openEnd >= 0 && closeStart >= 0, `#${selectId} must have a closing tag`);
  return parseDocument(document.html.slice(openEnd + 1, closeStart)).elements
    .filter((element) => element.tag === "option");
}

function optionValues(document: StaticDocument, selectId: string): readonly string[] {
  return optionsFor(document, selectId).map((option) => option.attributes.value ?? "");
}

function defaultOptionValue(document: StaticDocument, selectId: string): string {
  const options = optionsFor(document, selectId);
  assert.ok(options.length > 0, `#${selectId} must contain at least one option`);
  const selected = options.find((option) => hasAttribute(option, "selected")) ?? options[0]!;
  return selected.attributes.value ?? "";
}

function assertUniqueIds(document: StaticDocument): void {
  const duplicates = [...document.byId.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([id, matches]) => `${id} (${matches.length})`);
  assert.deepEqual(duplicates, [], `duplicate DOM IDs: ${duplicates.join(", ")}`);
}

function assertReferencedIds(document: StaticDocument): void {
  const referenceAttributes = ["aria-controls", "aria-describedby", "aria-labelledby"] as const;
  for (const element of document.elements) {
    for (const attribute of referenceAttributes) {
      const value = element.attributes[attribute];
      if (!value) continue;
      for (const id of value.split(/\s+/).filter(Boolean)) {
        elementById(document, id);
      }
    }
    if (element.tag === "output" && element.attributes.for) {
      for (const id of element.attributes.for.split(/\s+/).filter(Boolean)) {
        elementById(document, id);
      }
    }
  }
}

function assertLabelsAndButtons(document: StaticDocument): void {
  for (const label of document.elements.filter((element) => element.tag === "label")) {
    const targetId = label.attributes.for;
    if (!targetId) continue;
    const target = elementById(document, targetId);
    assert.ok(LABELABLE_TAGS.has(target.tag), `<label for="${targetId}"> targets non-labelable <${target.tag}>`);
  }

  for (const button of document.elements.filter((element) => element.tag === "button")) {
    assert.equal(button.attributes.type, "button", `${button.attributes.id ? `#${button.attributes.id}` : button.source} must declare type="button"`);
  }
}

function assertTabContracts(document: StaticDocument): void {
  const tabs = document.elements.filter((element) => element.attributes["data-tab"] !== undefined);
  const panels = document.elements.filter((element) => element.attributes["data-panel"] !== undefined);
  assert.ok(tabs.length > 0, "at least one tab is required");
  assert.equal(tabs.length, panels.length, "every tab must have exactly one tabpanel");

  const tabNames = tabs.map((tab) => tab.attributes["data-tab"]!);
  const panelNames = panels.map((panel) => panel.attributes["data-panel"]!);
  assert.equal(new Set(tabNames).size, tabs.length, "data-tab values must be unique");
  assert.equal(new Set(panelNames).size, panels.length, "data-panel values must be unique");
  assert.deepEqual(new Set(panelNames), new Set(tabNames), "data-tab and data-panel names must match");

  const selectedTabs = tabs.filter((tab) => tab.attributes["aria-selected"] === "true");
  const visiblePanels = panels.filter((panel) => !hasAttribute(panel, "hidden"));
  assert.equal(selectedTabs.length, 1, "exactly one tab must be initially selected");
  assert.equal(visiblePanels.length, 1, "exactly one tabpanel must be initially visible");

  for (const tab of tabs) {
    const name = tab.attributes["data-tab"]!;
    const tabId = `tab-${name}`;
    const panelId = `panel-${name}`;
    assert.equal(tab.tag, "button", `[data-tab="${name}"] must be a button`);
    assert.equal(tab.attributes.id, tabId);
    assert.equal(tab.attributes.role, "tab");
    assert.equal(tab.attributes["aria-controls"], panelId);
    assert.ok(tab.attributes["aria-selected"] === "true" || tab.attributes["aria-selected"] === "false");

    const panel = elementById(document, panelId);
    assert.equal(panel.attributes["data-panel"], name);
    assert.equal(panel.attributes.role, "tabpanel");
    assert.equal(panel.attributes["aria-labelledby"], tabId);

    const selected = tab.attributes["aria-selected"] === "true";
    assert.equal(classNames(tab).has("is-active"), selected, `${tabId} active class must match aria-selected`);
    assert.equal(classNames(panel).has("is-active"), selected, `${panelId} active class must match its tab`);
    assert.equal(hasAttribute(panel, "hidden"), !selected, `${panelId} hidden state must be the inverse of selection`);
    if (selected) assert.notEqual(tab.attributes.tabindex, "-1", `${tabId} must remain keyboard reachable`);
    else assert.equal(tab.attributes.tabindex, "-1", `${tabId} must use roving tabindex`);
  }

  assert.equal(
    visiblePanels[0]!.attributes["data-panel"],
    selectedTabs[0]!.attributes["data-tab"],
    "the visible panel must belong to the selected tab",
  );
}

function sourceFilesWithDomReferences(): readonly string[] {
  const controllerPaths = readdirSync(path.join(ROOT, "src"))
    .filter((name) => name.endsWith("-controller.ts"))
    .map((name) => path.join(ROOT, "src", name));
  return [path.join(ROOT, "index.ts"), path.join(ROOT, "src", "ui.ts"), ...controllerPaths];
}

function extractLiteralDomIds(source: string): ReadonlySet<string> {
  const ids = new Set<string>();
  const helperPattern = /\b(?:(?:element|optionalElement)(?:<[^>\r\n]+>)?|bind|valueOf|numberOf|checkedOf|setText|setValue|setChecked|required|optional)\s*\(\s*["'`]([a-z][a-z0-9-]+)["'`]/g;
  for (const match of source.matchAll(helperPattern)) {
    if (match[1]) ids.add(match[1]);
  }

  const loopPattern = /for\s*\(\s*const\s+(?:id|\[[^\]]+\])\s+of\s+\[([\s\S]*?)\]\s*(?:as const)?\s*\)/g;
  for (const loop of source.matchAll(loopPattern)) {
    const body = loop[1] ?? "";
    for (const literal of body.matchAll(/["'`]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)["'`]/g)) {
      if (literal[1]) ids.add(literal[1]);
    }
  }
  return ids;
}

function assertSourceDomReferences(document: StaticDocument): void {
  const references = new Map<string, string[]>();
  for (const filePath of sourceFilesWithDomReferences()) {
    const relativePath = path.relative(ROOT, filePath).replaceAll("\\", "/");
    const source = readFileSync(filePath, "utf8");
    for (const id of extractLiteralDomIds(source)) {
      const files = references.get(id) ?? [];
      files.push(relativePath);
      references.set(id, files);
    }
  }
  references.set("log-list", ["src/ui.ts ActivityLog default"]);

  const missing = [...references.entries()]
    .filter(([id]) => (document.byId.get(id) ?? []).length !== 1)
    .map(([id, files]) => `#${id} <- ${files.join(", ")}`)
    .sort();
  assert.deepEqual(missing, [], `source-referenced DOM IDs missing or duplicated:\n${missing.join("\n")}`);
}

function assertFeatureIds(document: StaticDocument): void {
  for (const [feature, ids] of Object.entries(FEATURE_IDS)) {
    for (const id of ids) {
      elementById(document, id);
    }
    assert.ok(ids.length > 0, `${feature} contract must not be empty`);
  }
}

function assertLiveRegions(document: StaticDocument): void {
  assert.equal(elementById(document, "final-qc-results").attributes["aria-live"], "polite");
  assert.equal(elementById(document, "ai-job-list").attributes["aria-live"], "polite");
  const subtitleStatus = elementById(document, "subtitle-status");
  assert.equal(subtitleStatus.attributes.role, "status");
  assert.equal(subtitleStatus.attributes["aria-live"], "polite");
  const subtitleList = elementById(document, "subtitle-cue-list");
  assert.equal(subtitleList.attributes.role, "list");
  assert.equal(subtitleList.attributes["aria-live"], "polite");
  assert.equal(elementById(document, "subtitle-editor").attributes["aria-labelledby"], "subtitle-editor-heading");
}

function assertOperationalUiContracts(document: StaticDocument): void {
  for (const id of OPERATIONAL_UI_IDS) elementById(document, id);

  const recoveryCount = elementById(document, "recovery-count");
  assert.equal(recoveryCount.attributes["aria-label"], "복구 기록 수");
  const recoveryList = elementById(document, "recovery-list");
  assert.equal(recoveryList.attributes["aria-live"], "polite");
  assert.equal(recoveryList.attributes["aria-relevant"], "additions text");
  const recoveryDialog = elementById(document, "recovery-confirm-dialog");
  assert.equal(recoveryDialog.tag, "dialog");
  assert.equal(recoveryDialog.attributes["aria-labelledby"], "recovery-confirm-title");
  assert.equal(recoveryDialog.attributes["aria-describedby"], "recovery-confirm-description");

  const runButton = elementById(document, "run-diagnostics-btn");
  const exportButton = elementById(document, "export-diagnostics-btn");
  assert.equal(runButton.tag, "button");
  assert.equal(exportButton.tag, "button");
  assert.ok(!hasAttribute(runButton, "disabled"), "diagnostics must be runnable initially");
  assert.ok(hasAttribute(exportButton, "disabled"), "diagnostics export must wait for a report");

  const summary = elementById(document, "diagnostics-summary");
  assert.equal(summary.attributes.role, "status");
  assert.equal(summary.attributes["aria-live"], "polite");
  assert.ok(classNames(summary).has("is-idle"), "diagnostics summary must start idle");
  assert.equal(elementById(document, "diagnostics-list").attributes["aria-live"], "polite");

  const text = visibleText(document.html);
  assert.ok(text.includes("비파괴 작업 복구"));
  assert.ok(text.includes("자동 편집 전 생성한 검증된 복제 시퀀스와 작업 상태를 최대 50개까지 기록합니다."));
  assert.ok(text.includes("진단 실행"));
  assert.ok(text.includes("진단 JSON 저장"));
  assert.ok(text.includes("자동 외부 전송은 하지 않습니다."));
  assert.ok(text.includes("JSON 저장 시 API 키, 경로, 미디어명, 원고 등 민감 정보는 제거됩니다."));
}

function assertOperationalSourceContracts(source: string): void {
  assert.match(source, /bind\("run-diagnostics-btn",\s*"click",\s*guarded\(handleRunDiagnostics/);
  assert.match(source, /bind\("export-diagnostics-btn",\s*"click",\s*guarded\(handleExportDiagnostics/);
  assert.match(source, /button\.type\s*=\s*"button";[\s\S]*?button\.textContent\s*=\s*"복제본 제거";/);
  assert.match(source, /removeVerifiedClonedSequence\(/);
  assert.match(source, /dialog\.uxpShowModal\.bind\(dialog\)/);
  assert.match(source, /if \(!await requestRecoveryRollbackConfirmation\(entry\)\)/);
  assert.doesNotMatch(source, /globalThis as unknown as \{ confirm\?/);

  assert.equal(tokenCount(source, "collectDiagnosticsReport"), 2, "diagnostics collection must occur only in its click handler");
  assert.equal(tokenCount(source, "handleRunDiagnostics"), 2, "diagnostics execution must have only its declaration and click binding");
  assert.equal(tokenCount(source, "handleExportDiagnostics"), 2, "diagnostics export must have only its declaration and click binding");
  assert.equal(tokenCount(source, "TelemetryManager"), 0, "the panel must not start an automatic telemetry sender");

  const exportHandler = /async function handleExportDiagnostics\(\): Promise<void> \{[\s\S]*?\n\}/u.exec(source)?.[0] ?? "";
  const selfCheckIndex = exportHandler.indexOf("assertDiagnosticRedactionSelfCheck();");
  const pickerIndex = exportHandler.indexOf("getFileForSaving?.(");
  assert.ok(selfCheckIndex >= 0, "diagnostics export must run the active redaction self-check");
  assert.ok(pickerIndex > selfCheckIndex, "redaction self-check must run before opening the save picker");
  assert.match(source, /diagnosticBundleToJSON\(\{[\s\S]*?reportPurpose:\s*"user-initiated-local-export"/);
  assert.match(source, /getFileForSaving\?\.\([\s\S]*?ShortFlow_Diagnostics_/);
  assert.match(source, /await file\.write\(payload,/);
  assert.match(source, /function ensureAiConsent\(/);
  assert.match(source, /ensureAiConsent\("AI 자막"\)/);
  assert.match(source, /ensureAiConsent\("AI 연결 테스트"\)/);
  assert.match(source, /ensureAiConsent\("썸네일 AI"\)/);
  assert.match(source, /ensureAiConsent:\s*\(\)\s*=>\s*ensureAiConsent\("TTS\/STT"\)/);
  assert.match(source, /onWarning:\s*\(message\)\s*=>\s*activity\.add\("warning", message\)/);
  assert.match(source, /onSourceChange:\s*\(\)\s*=>\s*\{[\s\S]{0,240}?automationController\?\.setTranscript\(null\);[\s\S]{0,80}?\}/);
  assert.match(source, /onTranscript:\s*\(transcript\)\s*=>\s*\{[\s\S]{0,500}?automationController\?\.setTranscript\(/);
  assert.match(source, /controller\.cueCount === 0/);
  assert.match(source, /const generation = \+\+statusRefreshGeneration;[\s\S]*?controller\.projectKey !== projectKey[\s\S]*?await controller\.loadProject\(projectKey\)/);
  assert.match(source, /subtitleController\.setDocument\(createSubtitleDocument\([\s\S]{1,1600}?\), true\);/);
  assert.match(source, /createTtsAssetRightsRecord\(/);
  assert.match(source, /const sessionGeneratedAssetRightsIdsByProject = new Map<string, Set<string>>\(\);/);
  assert.match(source, /const normalizedReferenceId = nativePath \? normalizeNativePath\(nativePath\) : fallback\.assetId;/);
  assert.match(source, /function rememberSessionGeneratedAssetRights\(assetId: string, projectKey = SESSION_FALLBACK_PROJECT_KEY\): void/);
  assert.match(source, /const sessionGeneratedIds = sessionGeneratedAssetRightsIds\(projectKey\);/);
  assert.match(source, /sessionGeneratedIds\.has\(record\.assetId\)/);
  assert.match(source, /rememberSessionGeneratedAssetRights\(saved\.assetId, projectKey\);/);
  assert.match(source, /return \[\.\.\.visibleRecords, \.\.\.registryOnlyRecords\];/);
  assert.match(source, /function destroyPanel\(\): void/);
  assert.match(source, /void controller\.dispose\(\)\.catch\(\(error\) => reportError\(error, "썸네일 편집기 종료 저장 실패"\)\);/);
  assert.match(source, /destroy\(\)\s*\{[\s\S]{0,120}?destroyPanel\(\);[\s\S]{0,40}?\}/);

  const thumbnailSource = readFileSync(path.join(ROOT, "src", "thumbnail-controller.ts"), "utf8");
  assert.match(thumbnailSource, /button\.closest<HTMLElement>\("\.thumb-ai-card"\)/);
  assert.match(thumbnailSource, /button\.disabled \|\| card\?\.hidden/);
  assert.match(thumbnailSource, /썸네일 AI 보정은 내부 베타에서 비활성화되어 있습니다/);
}

function assertUiDefaults(document: StaticDocument): void {
  assert.deepEqual(optionValues(document, "ai-provider-select"), ["openai"]);
  assert.equal(defaultOptionValue(document, "ai-provider-select"), DEFAULT_SETTINGS.aiProvider);
  assert.equal(elementById(document, "ai-model-input").attributes.value, DEFAULT_SETTINGS.aiModel);
  assert.ok(!hasAttribute(elementById(document, "ai-consent-checkbox"), "checked"));
  const endpoint = elementById(document, "ai-endpoint-input");
  assert.equal(endpoint.attributes.value, "https://api.openai.com/v1");
  assert.ok(hasAttribute(endpoint, "readonly"), "the fixed OpenAI endpoint must be readonly");

  assert.deepEqual(optionValues(document, "tts-model-select"), ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"]);
  assert.equal(defaultOptionValue(document, "tts-model-select"), DEFAULT_SETTINGS.ttsModel);
  assert.equal(defaultOptionValue(document, "tts-voice-select"), DEFAULT_SETTINGS.ttsVoice);
  assert.deepEqual(optionValues(document, "tts-format-select"), ["wav", "mp3", "aac", "flac"]);
  assert.equal(defaultOptionValue(document, "tts-format-select"), DEFAULT_SETTINGS.ttsFormat);
  assert.equal(elementById(document, "tts-speed-input").attributes.value, String(DEFAULT_SETTINGS.ttsSpeed));

  assert.deepEqual(optionValues(document, "stt-model-select"), [
    "gpt-4o-transcribe-diarize",
    "gpt-4o-transcribe",
    "gpt-4o-mini-transcribe",
    "whisper-1",
  ]);
  assert.equal(defaultOptionValue(document, "stt-model-select"), DEFAULT_SETTINGS.sttModel);
  assert.equal(elementById(document, "stt-language-input").attributes.value, DEFAULT_SETTINGS.sttLanguage);
  assert.deepEqual(optionValues(document, "stt-output-format-select"), ["both", "srt", "text"]);
  assert.equal(defaultOptionValue(document, "stt-output-format-select"), DEFAULT_SETTINGS.sttOutputFormat);

  assert.deepEqual(optionValues(document, "brand-tts-model-select"), ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"]);
  assert.equal(defaultOptionValue(document, "brand-caption-position-select"), "bottom");
  assert.equal(elementById(document, "brand-caption-max-input").attributes.value, "24");
  assert.ok(hasAttribute(elementById(document, "brand-caption-shadow-checkbox"), "checked"));
  assert.ok(!hasAttribute(elementById(document, "brand-caption-highlight-checkbox"), "checked"));

  assert.equal(defaultOptionValue(document, "final-qc-platform-select"), "youtube-shorts");
  assert.equal(elementById(document, "final-qc-output-name").attributes.value, "ShortFlow_Export.mp4");
  assert.deepEqual(optionValues(document, "asset-rights-kind-select"), [
    "music",
    "sfx",
    "image",
    "video",
    "ai-audio",
    "ai-image",
    "ai-video",
    "other",
  ]);
  assert.equal(defaultOptionValue(document, "asset-rights-commercial-select"), "unknown");
  const thumbnailAiCard = document.elements.find((element) => classNames(element).has("thumb-ai-card"));
  assert.ok(thumbnailAiCard, "thumbnail AI card must remain in DOM for deferred roadmap wiring");
  assert.ok(hasAttribute(thumbnailAiCard, "hidden"), "thumbnail AI card must stay hidden in the internal beta UI");
  assert.ok(hasAttribute(elementById(document, "thumb-ai-preset-select"), "disabled"));
  assert.ok(hasAttribute(elementById(document, "thumb-ai-prompt-input"), "disabled"));
  assert.ok(hasAttribute(elementById(document, "thumb-ai-run-btn"), "disabled"));
  assert.equal(elementById(document, "ai-queue-concurrency-input").attributes.value, "2");
  assert.equal(elementById(document, "ai-request-limit-input").attributes.value, "100");
  assert.equal(elementById(document, "ai-cost-limit-input").attributes.value, "100");
  assert.equal(elementById(document, "ai-confirm-threshold-input").attributes.value, "10");
  assert.equal(elementById(document, "subtitle-max-chars-input").attributes.value, "19");
  assert.equal(elementById(document, "subtitle-translate-language-input").attributes.value, "영어");
}

function assertInitialDisabledStates(document: StaticDocument): void {
  for (const id of ["final-qc-waive-btn", "final-qc-json-btn", "final-qc-md-btn"]) {
    assert.ok(hasAttribute(elementById(document, id), "disabled"), `#${id} must start disabled`);
  }
  assert.ok(!hasAttribute(elementById(document, "final-qc-run-btn"), "disabled"));

  for (const id of [
    "subtitle-export-btn",
    "subtitle-undo-btn",
    "subtitle-redo-btn",
    "subtitle-reflow-btn",
    "subtitle-ai-reflow-btn",
    "subtitle-ai-review-btn",
    "subtitle-ai-translate-btn",
  ]) {
    assert.ok(hasAttribute(elementById(document, id), "disabled"), `#${id} must start disabled`);
  }
  assert.ok(!hasAttribute(elementById(document, "subtitle-import-btn"), "disabled"));
}

function assertCssContracts(css: string): void {
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important\s*;/s);
  assert.match(css, /html,\s*body\s*\{[^}]*height:\s*100%\s*;[^}]*min-height:\s*100%\s*;/s);
  assert.match(css, /body\s*\{[^}]*overflow:\s*hidden\s*;/s);
  assert.match(css, /\.app-shell\s*\{[^}]*display:\s*flex\s*;[^}]*flex-direction:\s*column\s*;[^}]*height:\s*100vh\s*;[^}]*overflow:\s*hidden\s*;/s);
  assert.match(css, /\.workspace\s*\{[^}]*flex:\s*1\s+1\s+auto\s*;[^}]*min-height:\s*0\s*;[^}]*overflow-y:\s*auto\s*;/s);
  assert.match(css, /\.two-column-layout\s*\{[^}]*display:\s*flex\s*;[^}]*flex-wrap:\s*wrap\s*;/s);
  assert.match(css, /\.two-column-layout\s*>\s*\*\s*\{[^}]*flex:\s*1\s+1\s+260px\s*;[^}]*min-width:\s*0\s*;/s);
  assert.match(css, /\.automation-workspace\s*\{[^}]*display:\s*flex\s*;[^}]*flex-wrap:\s*wrap\s*;/s);
  assert.match(css, /\.automation-card\s*\{[^}]*flex:\s*1\s+1\s+300px\s*;[^}]*min-width:\s*0\s*;/s);
  assert.match(css, /\.asset-workspace\s*\{[^}]*display:\s*flex\s*;[^}]*flex-wrap:\s*wrap\s*;/s);
  assert.match(css, /\.asset-sidebar\s*\{[^}]*flex:\s*1\s+1\s+260px\s*;/s);
  assert.match(css, /\.asset-browser\s*\{[^}]*flex:\s*2\s+1\s+320px\s*;/s);
  assert.match(css, /\.speech-workspace\s*\{[^}]*display:\s*flex\s*;[^}]*flex-wrap:\s*wrap\s*;/s);
  assert.match(css, /\.speech-card\s*\{[^}]*flex:\s*1\s+1\s+320px\s*;[^}]*min-width:\s*0\s*;/s);
  assert.match(css, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.asset-browser\s*\{[^}]*order:\s*-1\s*;/s);
  assert.match(css, /@media\s*\(max-width:\s*500px\)\s*\{[\s\S]*?\.app-header\s*\{[^}]*min-height:\s*48px\s*;[^}]*padding-top:\s*8px\s*;[^}]*padding-bottom:\s*8px\s*;/s);
  assert.match(css, /@media\s*\(max-width:\s*500px\)\s*\{[\s\S]*?\.sequence-status\s*\{[^}]*padding-top:\s*7px\s*;[^}]*padding-bottom:\s*7px\s*;/s);
  assert.match(css, /@media\s*\(max-width:\s*500px\)\s*\{[\s\S]*?\.status-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)\s*;[^}]*row-gap:\s*6px\s*;/s);
  assert.match(css, /@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.app-header\s*\{[^}]*min-height:\s*42px\s*;[^}]*padding-top:\s*6px\s*;[^}]*padding-bottom:\s*6px\s*;/s);
  for (const selector of [
    ".nav-tab[aria-selected=\"true\"]",
    ".workflow-panel",
    ".qc-status-strip",
    ".qc-status-item",
    ".final-qc-card",
    ".final-qc-results",
    ".final-qc-row.is-error",
    ".ai-queue-card",
    ".ai-job-list",
    ".ai-job-row.is-failed",
    ".brand-kit-card",
    ".brand-kit-toolbar",
    ".subtitle-editor-card",
    ".subtitle-status[data-status=\"error\"]",
    ".subtitle-cue-list",
    ".subtitle-word.is-active",
    ".subtitle-action-button:focus-visible",
  ]) {
    assert.ok(css.includes(selector), `styles.css is missing ${selector}`);
  }
}

function assertOperationalCssContracts(css: string): void {
  for (const selector of [
    ".recovery-card",
    ".recovery-count",
    ".recovery-list",
    ".recovery-row.is-interrupted",
    ".diagnostics-card",
    ".diagnostics-summary.is-green",
    ".diagnostics-summary.is-yellow",
    ".diagnostics-summary.is-red",
    ".diagnostics-list",
    ".diagnostic-row.is-green .diagnostic-state",
    ".diagnostic-row.is-yellow .diagnostic-state",
    ".diagnostic-row.is-red .diagnostic-state",
  ]) {
    assert.ok(css.includes(selector), `styles.css is missing ${selector}`);
  }
}

function assertSharedHtmlContracts(document: StaticDocument): void {
  assertUniqueIds(document);
  assertReferencedIds(document);
  assertLabelsAndButtons(document);
  assertTabContracts(document);
  assertFeatureIds(document);
  assertLiveRegions(document);
  assertUiDefaults(document);
  assertInitialDisabledStates(document);
}

describe("public UXP HTML contract", () => {
  const document = documentFromFile(PUBLIC_HTML_PATH);

  it("keeps IDs unique and every static relationship resolvable", () => {
    assertUniqueIds(document);
    assertReferencedIds(document);
    assertLabelsAndButtons(document);
  });

  it("keeps tabs and tabpanels in a complete accessible one-to-one mapping", () => {
    assertTabContracts(document);
  });

  it("provides every literal DOM ID consumed by index.ts and controllers", () => {
    assertSourceDomReferences(document);
  });

  it("keeps final QC, AI queue, brand kit, and subtitle integration surfaces complete", () => {
    assertFeatureIds(document);
    assertLiveRegions(document);
    assertInitialDisabledStates(document);
    assert.match(document.html, /id="subtitle-import-btn"[^>]*>SRT\/Whisper JSON 불러오기<\/button>/u);
    assert.match(readFileSync(path.join(ROOT, "index.ts"), "utf8"), /types:\s*\["srt", "json"\]/u);
  });

  it("publishes production model and control defaults", () => {
    assertUiDefaults(document);
  });
});

describe("AI endpoint safety contract", () => {
  it("pins restored settings to OpenAI instead of reviving a custom endpoint", () => {
    const restored = normalizeSettings({
      aiProvider: "custom",
      aiEndpoint: "https://attacker.example/v1",
    });
    assert.equal(restored.aiProvider, "openai");
    assert.equal(restored.aiEndpoint, DEFAULT_SETTINGS.aiEndpoint);
  });

  it("does not read a custom provider or editable endpoint back from index.ts", () => {
    const source = readFileSync(path.join(ROOT, "index.ts"), "utf8");
    assert.equal(
      /aiProvider\s*:\s*valueOf\("ai-provider-select"\)\s*===\s*"custom"/.test(source),
      false,
      "index.ts must not restore the removed custom provider path",
    );
    assert.equal(
      /aiEndpoint\s*:\s*valueOf\("ai-endpoint-input"\)/.test(source),
      false,
      "index.ts must not persist a DOM-supplied API endpoint",
    );
  });
});

describe("recovery and system diagnostics UI contract", () => {
  const document = documentFromFile(PUBLIC_HTML_PATH);
  // 복구 파괴적 동작 UI는 src/recovery-panel.ts로 분리됐으므로 두 소스를 함께 검사한다.
  const indexSource = readFileSync(path.join(ROOT, "index.ts"), "utf8")
    + readFileSync(path.join(ROOT, "src", "recovery-panel.ts"), "utf8");

  it("exposes recovery and diagnostics IDs with accessible initial states", () => {
    assertOperationalUiContracts(document);
  });

  it("keeps recovery destructive actions explicit and diagnostics user initiated", () => {
    assertOperationalSourceContracts(indexSource);
  });

  it("styles recovery and green, yellow, and red diagnostics states", () => {
    assertOperationalCssContracts(readFileSync(PUBLIC_CSS_PATH, "utf8"));
  });
});

describe("UXP visual state contract", () => {
  it("styles hidden panels, selected tabs, and integrated feature states", () => {
    assertCssContracts(readFileSync(PUBLIC_CSS_PATH, "utf8"));
  });

  it("binds workflow tabs only after the UXP panel DOM is ready", () => {
    const source = readFileSync(path.join(ROOT, "index.ts"), "utf8");
    const uiSource = readFileSync(path.join(ROOT, "src", "ui.ts"), "utf8");
    assert.match(source, /function whenDocumentReady\(task: \(\) => void\): void/u);
    assert.match(source, /document\.readyState === "loading"/u);
    assert.match(source, /document\.addEventListener\("DOMContentLoaded", task, \{ once: true \}\)/u);
    assert.match(source, /function startPanel\(\): void \{[\s\S]*setupTabs\(\);[\s\S]*bootstrap\(\)/u);
    assert.doesNotMatch(source, /\nsetupTabs\(\);\nstartPanel\(\);/u);
    assert.match(uiSource, /let tabsInitialized = false;/u);
    assert.match(uiSource, /function activateWorkflowTab\(tab: HTMLButtonElement/u);
    assert.match(uiSource, /function workflowTabFromEvent\(event: Event\): HTMLButtonElement \| null/u);
    assert.match(uiSource, /document\.addEventListener\("click"[\s\S]*activateWorkflowTab\(tab\);[\s\S]*true\);/u);
    assert.match(uiSource, /document\.addEventListener\("keydown"[\s\S]*activateWorkflowTab\(next, true\);[\s\S]*true\);/u);
    assert.match(uiSource, /tabsInitialized = true;/u);
  });

  it("keeps Premiere Safe Zone overlays on the Host-compatible BMP renderer", () => {
    const source = readFileSync(path.join(ROOT, "index.ts"), "utf8");
    const overlayFunction = /async function createPremiereSafeZoneOverlay[\s\S]*?\n\}\n\nfunction guarded/u.exec(source)?.[0] ?? "";
    assert.match(overlayFunction, /const expectedContextKey = await readActiveContextKey\(\);/u);
    assert.match(overlayFunction, /renderSafeZoneGuideBmp/u);
    assert.match(overlayFunction, /__SHORTFLOW_SAFE_GUIDE_DO_NOT_EXPORT__/u);
    assert.match(overlayFunction, /readSequenceStatus\(undefined, \{ expectedContextKey \}\)/u);
    assert.match(overlayFunction, /expectedContextKey,/u);
    assert.doesNotMatch(overlayFunction, /document\.createElement\("canvas"\)/u);
    assert.doesNotMatch(overlayFunction, /canvasToPngBytes/u);
  });
});

describe("built UXP artifact contract", () => {
  it("preserves public HTML contracts in dist/index.html", { skip: !existsSync(DIST_HTML_PATH) }, () => {
    assertSharedHtmlContracts(documentFromFile(DIST_HTML_PATH));
  });

  it("preserves public CSS contracts in dist/styles.css", { skip: !existsSync(DIST_CSS_PATH) }, () => {
    assertCssContracts(readFileSync(DIST_CSS_PATH, "utf8"));
  });

  const distHasOperationalUi = existsSync(DIST_HTML_PATH)
    && readFileSync(DIST_HTML_PATH, "utf8").includes('id="run-diagnostics-btn"');
  it("preserves recovery and diagnostics contracts after rebuilding dist", { skip: !distHasOperationalUi }, () => {
    assertOperationalUiContracts(documentFromFile(DIST_HTML_PATH));
    assertOperationalCssContracts(readFileSync(DIST_CSS_PATH, "utf8"));
  });
});

describe("internal beta packaging contract", () => {
  it("keeps production source maps out of dist and CCX candidates", () => {
    const viteConfig = readFileSync(path.join(ROOT, "vite.config.mjs"), "utf8");
    const verifyDist = readFileSync(path.join(ROOT, "scripts", "verify-dist.mjs"), "utf8");
    const verifyRelease = readFileSync(path.join(ROOT, "scripts", "verify-release.mjs"), "utf8");
    assert.match(viteConfig, /sourcemap:\s*false/);
    assert.match(verifyDist, /source map을 포함하지 않습니다/);
    assert.match(verifyDist, /sourceMappingURL을 포함하지 않습니다/);
    assert.match(verifyRelease, /source map을 포함하지 않습니다/);
  });
});
