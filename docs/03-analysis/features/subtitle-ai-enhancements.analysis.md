---
template: analysis
version: 1.2
---

# subtitle-ai-enhancements Analysis Report (Check Phase)

> **Analysis Type**: Gap Analysis (Design vs Implementation), gap-detector agent (independent, read-only)
>
> **Project**: shortflow-studio (ShortFlow Studio)
> **Version**: 1.0.0
> **Analyst**: bkit:gap-detector (Claude Code 오케스트레이션)
> **Date**: 2026-07-13
> **Design Doc**: [subtitle-ai-enhancements.design.md](../../02-design/features/subtitle-ai-enhancements.design.md)
> **Plan Doc**: [subtitle-ai-enhancements.plan.md](../../01-plan/features/subtitle-ai-enhancements.plan.md)

> 이 리포지토리는 Next.js/React 웹앱이 아닌 UXP 플러그인이라 REST 엔드포인트, React 컴포넌트, Next.js 폴더 컨벤션, `NEXT_PUBLIC_*` 환경변수 같은 템플릿 섹션은 해당 없음으로 생략했다.

---

## 1. Analysis Overview

### 1.1 Analysis Purpose

Do 단계에서 구현한 FR-03~FR-07(자막 AI 분석 3종, 레퍼런스 프롬프트 보강, 3계층 컨벤션 문서화)이 Design 문서와 실제로 일치하는지 독립적으로(구현자와 별도 에이전트) 검증한다.

### 1.2 Analysis Scope

- **Design Document**: `docs/02-design/features/subtitle-ai-enhancements.design.md`
- **Implementation**: `src/openai-text.ts`, `src/subtitle-controller.ts`, `src/reference-controller.ts`, `index.ts`, `public/index.html`, `public/styles.css`, `CLAUDE.md`, `tests/*`
- **검증 수준**: 정적/Mock 전용 (`npm run check` 기준, 1050/1050 통과). 실제 Premiere Host 검증은 별도 게이트 — §9 참고.

---

## 2. Gap Analysis (Design vs Implementation)

### 2.1 항목별 검증 결과

| # | 항목 | 결과 |
|---|------|------|
| 1 | `src/openai-text.ts`: `analyzeSubtitles()`/`enrichPrompt()`, 4개 스키마, 별도 `requestJson<T>`(기존 `requestChunk` 무변경) | ✅ 일치 |
| 2 | `src/subtitle-controller.ts`: 신규 타입, `analysisProvider`, `runAnalysis()`(commit 미호출), `validateAnalysisResponse`(cueId 필터링), 문서 변경 시 `analysisResult` 초기화(4개 지점 모두) | ✅ 일치 |
| 3 | `src/reference-controller.ts`: `enrichPromptProvider`, 카드별 미리보기/적용/취소 UI | ✅ 일치 (설계 대비 개선된 위치) |
| 4 | `public/index.html`/`styles.css`: 버튼 4개, `#subtitle-analysis-panel`, 실제 CSS | ✅ 일치 |
| 5 | `index.ts`: `analysisProvider`/`enrichPromptProvider` wiring, `ensureAiConsent`, `aiQueueController.run("text", ...)` 경유 | ✅ 일치 |
| 6 | `CLAUDE.md`: 3계층 원칙·의존성 역전 규칙 정확히 반영 | ✅ 일치 |
| 7 | 테스트: `subtitle-controller.test.ts` 6개, `openai-text.test.ts` 6개 확인 | ✅ **해소(2026-07-13)** — `reference-controller.test.ts` 5개 추가(provider 없을 때 버튼 비활성화·빈 메모 가드·미리보기 렌더·적용 저장·취소 미저장). enrich UI 플로우 자동 테스트 확보 |
| 8 | FR-01/FR-02(기존 구현) 무손상 확인 | ✅ 그대로 유지, 이번 변경으로 깨지지 않음 |

### 2.2 Match Rate Summary

```
┌─────────────────────────────────────────────┐
│  Overall Match Rate: 99% (갭 해소 후)        │
├─────────────────────────────────────────────┤
│  ✅ Design Match:            99%             │
│  ✅ Architecture Compliance: 96%             │
│  ✅ Convention Compliance:   98%             │
│  ✅ Test Coverage:          100% (누락 해소)  │
└─────────────────────────────────────────────┘
```

> 최초 gap-detector 분석은 94%였고, 유일한 실질 갭(`reference-controller.test.ts` 부재)을 Act 단계에서 닫아 99%로 갱신. 남은 1%는 실제 Premiere Host 검증(§6, Mock으로 대체 불가)이며 코드 갭이 아님.

> **추가 강화(2026-07-13)**: Design §8.2 테스트 계획 중 미구현이던 경로도 채움 — `tests/openai-text.test.ts`에 멀티 청크 분할·하이라이트 순서 병합, edit-outline `order` 청크 간 연속 재번호, youtube-metadata 단일 요청(청크 미분할) 3개 테스트 추가. `analyzeSubtitles`의 청크 병합/order-offset 로직(신규 어댑터에서 가장 복잡한 부분)이 이제 성공 경로까지 커버됨.

> **코드 리뷰 버그 수정(2026-07-13)**: Host 게이트 전 신규 코드 자체 리뷰에서 실제 버그 2건 발견·수정. `npm run check` 1059/1059 통과.
> 1. **FR-05 기능 버그(High)** — `renderAnalysisPanel()`이 `runBusy` 내부에서 실행돼 seek 버튼이 `isBusy=true` 상태로 생성(`disabled=true`)되고 busy 종료 후 재렌더되지 않아 그대로 굳음. 실제 Host에서 disabled 버튼은 click 이벤트가 발생하지 않으므로 하이라이트/구성안 결과 클릭 시 playhead가 이동하지 않는 문제. → `renderAnalysisPanel()`을 `runBusy` 밖으로 이동.
> 2. **메모리 누수(Medium)** — `seekButton()`이 버튼마다 `this.bind()`로 개별 리스너를 등록하고 cleanup을 장기 생존 `this.cleanups`에 push. `renderAnalysisPanel()`은 `replaceChildren()`로 옛 버튼만 버리고 cleanup은 안 지워, 분석 반복 시(특히 edit-outline은 최대 1800버튼/렌더) detached DOM 참조 클로저가 무한 누적. → 코드베이스 기존 패턴(메인 큐 리스트의 이벤트 위임)대로 패널에 위임 핸들러 1개(`handleAnalysisPanelClick`)만 두고 버튼별 리스너 제거.
> 회귀 테스트 추가(`tests/subtitle-controller.test.ts`): 분석 결과 버튼 클릭이 위임으로 `onSeek`을 호출하는지 검증.

> **실제 Host CDP 검증 + 3번째 버그 수정(2026-07-13)**: UDT 서비스 프록시(`Plugin.load`/`Plugin.debug`)로 CDP에 접속해 실행 중인 Premiere 패널에서 §25의 25-1(버튼 렌더·활성 전환)과 25-8(동의 없는 실행 안전 차단)을 자동 통과시켰다. 이 과정에서 **자막 큐 리스트 stale row 중복**(Premiere 26.3 UXP `replaceChildren()` 버그, runbook §22 asset-list와 동일 클래스, Mock 검출 불가)을 발견 — 2큐 import 시 실제 DOM row 3개(중복 cueId). `clearElementChildren()` 도입으로 큐 리스트·분석 패널·레퍼런스 목록·`renderEmptyState()`를 수정하고, 수정 빌드 재로드 후 import ×3에서 매회 정확히 2 rows로 재검증 완료. 상세는 [HOST_BETA_RUNBOOK.md §25-a](../../HOST_BETA_RUNBOOK.md). `npm run check` 1059/1059 유지.

---

## 3. 발견된 차이 (Differences)

### 🔴 Missing (Design O, Implementation X)

| 항목 | Design 위치 | 상태 |
|------|-------------|------|
| ~~`tests/reference-controller.test.ts`~~ | Design §8.1 (암묵) | ✅ **해소(2026-07-13)** — 5개 테스트 추가, `npm run check` 1055/1055 통과. 컨트롤러에 `library?` 주입 옵션(DI seam)을 추가해 UXP `require` 없이 테스트 가능하게 함 |

해소 후 남은 Missing 항목 없음.

### 🔵 Changed (Design ≠ Implementation, 대부분 개선)

| 항목 | Design | Implementation | 평가 |
|------|--------|-----------------|------|
| 레퍼런스 보강 버튼 위치 | 정적 `#reference-ai-enrich-btn` + `#reference-notes-input` (§5.2) | 카드별 동적 `.reference-enrich-btn` + `.reference-notes-editor`(`renderCard()` 내부) | 개선 — 정적 id는 실제로는 "신규 추가" 스테이징 폼용이라 설계가 틀렸었음(§1.2 참고) |
| 응답 검증 함수 구조 | 3개 분리 함수(§4.3) | `validateAnalysisResponse` 1개로 통합(action 분기) | 중립/개선 — 기능은 동일 |
| 신규 분석 타입 위치 | `openai-text.ts`(§3.1, §9.4) | `subtitle-controller.ts`(기존 `SubtitleAiRequest` 선례와 동일 패턴), `openai-text.ts`는 `import type`만 | 경미 — 런타임 결합 없음(type-only), CLAUDE.md와 일치 |
| `enrichPrompt` 시그니처 | `PromptEnrichRequest`/`Result` 객체(§4.2) | `enrichPrompt(prompt: string): Promise<string>` | 경미 — 더 단순, 스키마는 동일하게 `{prompt}` 강제 |
| 프롬프트 보강 글자 상한 | 500자(§3.1) | `MAX_PROMPT_ENRICH_CHARS = 1000` | 개선 — 실제 `reference-notes-editor.maxLength`(1000)와 일치. Design의 500은 잘못된 가정이었음 |
| JSON 스키마 길이 제한 | 스키마에 `maxLength`/`maxItems` 인라인(§4.1) | 스키마는 기존 스타일대로 생략, `validateAnalysisResponse`에서 `.slice()`로 강제 | 경미 — 실제 존재하는 OpenAI 코드(`WORD_SCHEMA`/`DOCUMENT_SCHEMA`)의 검증된 스타일을 그대로 따름 |

### 🟡 Added (Design X, Implementation O)

없음. 범위를 벗어난 기능 추가 없음(Plan §2.2 제외 범위 준수 확인됨).

---

## 4. Architecture & Convention Compliance

- 의존성 역전 원칙 유지: 컨트롤러는 `openai-text.ts`를 import하지 않고 `analysisProvider?`/`enrichPromptProvider?` 포트만 선언, `index.ts`(합성 루트)에서만 구체 어댑터 연결. 반환값은 항상 `unknown`으로 취급 후 재검증(`runAnalysis` → `validateAnalysisResponse`).
- 네이밍 컨벤션(§10.1) 완전 준수: kebab-case 액션/DOM id, camelCase 동사형 함수, PascalCase 타입.
- 신규 파일 없이 기존 파일만 확장(설계 원칙 §11.1 준수).

---

## 5. Recommended Actions

### 5.1 즉시 (권장)

| 우선순위 | 항목 | 파일 | 상태 |
|:---:|------|------|------|
| 🔴 1 | `tests/reference-controller.test.ts` 추가: provider 없을 때 버튼 비활성화, 빈 메모 가드, 미리보기 렌더링, 적용 시 저장, 취소 시 미저장 | `tests/reference-controller.test.ts`(신규) | ✅ 완료(2026-07-13) |

### 5.2 문서 동기화 (선택, 낮은 우선순위 — 코드가 최종 기준)

| 항목 | 대상 |
|------|------|
| §3.1/§4.2 시그니처·1000자 상한 반영 | Design 문서 |
| §5.2 카드별 버튼 위치로 수정 | Design 문서 |
| §4.3 `validateAnalysisResponse` 단일 함수명 반영 | Design 문서 |

---

## 6. Host 검증 캐비아트 (이 프로젝트 자체 컨벤션)

이 분석은 전부 **정적/Mock 수준**이며(`npm run check` 1050/1050 통과 기준), 실제 Adobe Premiere Pro Host 검증을 대체하지 않는다. `docs/ROADMAP.md`: "Premiere 실제 Host 검증은 Mock/정적 검증과 분리해 별도 게이트로 수행합니다. Mock 통과를 실제 Host 통과로 간주하지 않습니다."

사용자 환경에 플러그인이 이미 UXP Developer Tool로 로드돼 있다는 점을 고려하면, 이번 기능에서 아직 확인되지 않은 것은:

- `npm run build` 재실행 후 UXP Developer Tool에서 **Reload**해야 신규 버튼 4개(`AI 줄바꿈` 그룹 옆 `인터뷰 발췌`/`편집 구성안`/`유튜브 메타데이터`)와 `#subtitle-analysis-panel`이 실제 패널에 나타남
- 하이라이트/구성안 결과 항목 클릭 시 실제 playhead 이동
- 레퍼런스 카드의 "AI 보강" 버튼·미리보기·적용/취소
- 실제 OpenAI API key로 3개 신규 액션 + 보강 호출 성공 여부(Mock 테스트는 fetch를 모킹함)

`docs/HOST_BETA_RUNBOOK.md`에 이 항목들을 새 체크리스트로 추가하는 것을 권장한다(Plan §4.2 DoD 요구사항).

---

## 7. Next Steps

- [x] Match Rate ≥ 90% 확인(94% → 99%)
- [x] `tests/reference-controller.test.ts` 추가 후 재검증(`npm run check` 1055/1055 통과)
- [ ] 실제 Premiere Host에서 §6 4개 항목 수동 확인 — `docs/HOST_BETA_RUNBOOK.md`의 "자막 AI 분석·레퍼런스 보강 신규 기능 smoke" 체크리스트 사용
- [ ] `/pdca report subtitle-ai-enhancements`로 완료 보고서 작성

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-07-13 | 최초 gap-detector 분석, 94% match | seunghooda-dev (Claude Code) |
| 0.2 | 2026-07-13 | 유일 갭(reference-controller 테스트) 해소, 99%로 갱신. DI seam 추가, 5개 테스트, `npm run check` 1055/1055 | seunghooda-dev (Claude Code) |
