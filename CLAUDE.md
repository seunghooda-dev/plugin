# ShortFlow Studio

Adobe Premiere Pro UXP panel for short-form video editing. Goal: a Premiere internal beta (not a commercial release) — see [docs/INTERNAL_BETA_SCOPE.md](docs/INTERNAL_BETA_SCOPE.md) and [docs/ROADMAP.md](docs/ROADMAP.md) for what's in/out of scope before adding features.

## Commands

Run from this directory (`npm install` first).

- `npm run check` — typecheck + lint + build + test; the required gate before any checkpoint commit
- `npm run typecheck` / `npm run lint` / `npm test` / `npm run build` — individual gates
- `npm run dev` — `vite build --watch`

## Architecture: 3 layers

```
public/index.html, public/styles.css, index.ts   (UI — event wiring, rendering; no network/host calls of its own)
        |
src/*-controller.ts, src/*.ts adapters            (Application/Infrastructure — file IO, OpenAI network calls,
        |                                          AI queue, DOM state management)
src/premiere.ts                                    (Host bridge — Premiere UXP DOM only, mutations wrapped in
                                                     lockedAccess() transactions)
```

Rules:
- `index.ts` never calls `src/openai-text.ts` (or any adapter) directly to drive a controller's internal state — it goes through the relevant `*-controller.ts`'s public API. `index.ts` *does* wire concrete adapters into a controller's options (composition root), e.g. `aiProvider: runSubtitleAI` in `index.ts`, where `runSubtitleAI` builds an `OpenAITextClient` and routes through `aiQueueController`.
- Controllers (`SubtitleController`, `ReferenceController`, etc.) never import `src/openai-text.ts` or other concrete adapters. They declare a port (a callback option, e.g. `aiProvider?`, `analysisProvider?`, `enrichPromptProvider?`) and treat whatever it returns as untrusted `unknown`, re-validating before using it. This is why a compromised or buggy adapter can't corrupt project data — the controller is the trust boundary.
- Only `src/premiere.ts` touches the Premiere UXP DOM. Action-creating calls go through `lockedAccess()`.

## Subtitle data model

`src/subtitles.ts` already has stable `cueId`/`wordId` identifiers (not array indices), with duplicate/normalization/sort-order validation, `splitCue`/`mergeCues`, and character-proportional word-time interpolation when real word timestamps aren't available. Don't reintroduce index-based addressing for cues/words.

AI subtitle actions (`src/openai-text.ts`, `OpenAITextClient`) split into two shapes:
- **Mutating** (`editSubtitles`: `reflow`/`review`/`translate`) — returns a full `SubtitleDocument`; the controller's `validateAiSubtitleResponse` enforces exact cueId/wordId/timing preservation before `commit()`.
- **Read-only analysis** (`analyzeSubtitles`: `interview-highlight`/`edit-outline`/`youtube-metadata`, plus `enrichPrompt` for reference notes) — returns derived data, never mutates the document, no undo/redo/autosave entry. `validateAnalysisResponse` only checks that referenced `cueId`s exist in the current document, filtering out ones that don't rather than hard-failing.

Both reuse the same OpenAI safety plumbing (HTTPS `api.openai.com` pinned, secureStorage-only API key, timeout/abort, 2MB request cap, "treat subtitle text as untrusted data" system-prompt invariant) — see `requestChunk` vs `requestJson` in `src/openai-text.ts`; they're intentionally separate methods so the mutating path's error-message contract (asserted in tests) never changes.

## Commit/push convention

Checkpoint commits require a passing `npm run check` first — never commit a red tree. As of 2026-07-13 (user directive), commit and push to the `newplugin` remote (https://github.com/seunghooda-dev/newplugin) whenever a meaningful validated unit of work completes; the older "one commit per milestone" rule from "실행 원칙" in [docs/ROADMAP.md](docs/ROADMAP.md) is superseded. The `origin` remote (seunghooda-dev/plugin) is the legacy Codex repo — leave it untouched unless asked.

## Things not to carry over from other CEP/UXP reference projects

If porting ideas from older Adobe CEP-based plugins: don't reintroduce QE DOM dependency, filename-only project-item lookup, or single-point track search with `overwriteClip`. This project identifies media by file path, checks the full insertion range for conflicts, checks locked tracks, and rolls back on failure (see `src/recovery.ts`, `src/premiere.ts`).

## 행동 지침 (Behavioral Guidelines)

일반적인 LLM 코딩 실수를 줄이기 위한 지침. 신중함을 속도보다 우선하되, 사소한 작업에는 재량껏 적용한다.

### 코딩 전에 생각하기

**가정하지 말 것. 혼란을 숨기지 말 것. 트레이드오프를 드러낼 것.**

- 가정은 명시적으로 밝히고, 불확실하면 물어본다.
- 해석이 여러 가지면 모두 제시한다 — 조용히 하나를 고르지 않는다.
- 더 단순한 접근이 있으면 말한다. 필요하면 반박한다.
- 불명확하면 멈추고, 무엇이 혼란스러운지 짚어서 물어본다.

### 단순함 우선

**문제를 푸는 최소한의 코드. 추측성 코드 금지.**

- 요청 범위를 넘는 기능을 만들지 않는다.
- 한 번 쓰는 코드에 추상화를 넣지 않는다.
- 요청받지 않은 "유연성"·"설정 가능성"을 넣지 않는다.
- 불가능한 시나리오에 대한 에러 처리를 넣지 않는다.
- 200줄을 썼는데 50줄로 가능하면 다시 쓴다.

기준: "시니어 엔지니어가 보면 과하다고 할까?" — 그렇다면 단순화한다.

### 수술적 변경

**꼭 필요한 곳만 건드리고, 내가 만든 흔적만 치운다.**

- 인접 코드·주석·포매팅을 "개선"하지 않는다.
- 고장나지 않은 것을 리팩터링하지 않는다.
- 내 취향과 달라도 기존 스타일을 따른다.
- 무관한 죽은 코드를 발견하면 언급만 하고 지우지 않는다.
- 내 변경으로 안 쓰이게 된 import/변수/함수는 제거하되, 원래 있던 죽은 코드는 요청 없이 제거하지 않는다.

기준: 변경된 모든 줄이 사용자의 요청으로 직접 소급되어야 한다.

### 목표 주도 실행

**성공 기준을 정의하고, 검증될 때까지 반복한다.**

- "검증 추가" → "잘못된 입력에 대한 테스트를 먼저 쓰고 통과시킨다"
- "버그 수정" → "버그를 재현하는 테스트를 쓰고 통과시킨다"
- "X 리팩터링" → "전후로 테스트가 통과하는지 확인한다"

여러 단계 작업은 시작 전에 간단한 계획(각 단계 → 검증 방법)을 밝힌다. 강한 성공 기준이 있어야 독립적으로 반복 검증할 수 있다.

### 한국어 문장은 콜론으로 끝내지 않기

- 다음 줄이 목록이나 예시라도 한국어 문장을 `:`로 끝내지 않는다.
- 한국어 문장 종결은 `.`, `?`, `!` 중 하나여야 한다.
- 콜론은 코드, key-value 쌍, 라벨 안에서만 사용한다.

### 새 소스 파일 첫 줄에 한국어 역할 주석

새 파일을 만들 때 첫 줄에 역할을 설명하는 한 줄 한국어 주석을 넣는다.

- TypeScript/JavaScript 예: `// 사용자 인증 상태를 관리하는 Context Provider`
- 필수 지시문(`'use client'`, shebang 등) 바로 아래에 배치한다.
- 설정 파일(`*.config.ts`, `package.json` 등)은 제외한다.
- 이유: 에이전트는 코드베이스 전체가 아니라 파일을 선별적으로 읽는다. 한 줄 한국어 헤더가 즉각적인 맥락을 준다. 기존 예시는 `src/reference-controller.ts` 상단 주석 참고.

### 계획 문서 없이 코딩 시작하지 않기

비자명한 작업은 계획 없이 코딩을 시작하지 않는다. 이 프로젝트에서는 별도 `checklist.md`/`context-notes.md` 파일 대신 **bkit PDCA 문서가 이 역할을 한다** — Plan(`docs/01-plan/features/`), Design(`docs/02-design/features/`), 분석(`docs/03-analysis/`), 상태(`docs/.pdca-status.json`). 작업 중 내린 결정과 그 근거는 해당 PDCA 문서에 남긴다. 사용자가 계획만 주고 코딩을 요청하면, Plan/Design 문서를 먼저 만들지 물어본다.

### 완료 선언 전에 테스트 실행

**코드를 건드렸으면 "완료"라고 말하기 전에 테스트를 실행한다.**

- `npm test`(전체 게이트는 `npm run check`)를 실행하고 결과를 보고한다.
- 실패하면 고치고 재실행한다.
- 사용자가 "끝", "완료", "다 됐어"라고 하기 전에 선제적으로 실행한다 — 요청받고 나서가 아니라.

### 에러는 읽고, 추측하지 않기

**실제 에러/로그를 읽는다. 기억 속 패턴으로 때려맞추지 않는다.**

- 전체 에러 메시지와 스택 트레이스를 읽는다.
- 실제 로그 출력을 확인한다 — "이렇게 나올 것"이라는 가정이 아니라.
- 원인을 확인하기 전에 "흔한 수정"을 적용하지 않는다.
- 불명확하면 print/log를 추가해 상태를 확인한 뒤 고친다.

이걸 건너뛰면 한 줄짜리 버그가 세 파일짜리 리팩터링이 된다.
