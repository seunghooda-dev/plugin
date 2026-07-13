---
template: plan
version: 1.2
---

# 자막 편집 AI 기능 고도화 (subtitle-ai-enhancements) Planning Document

> **Summary**: 재생 연동 자막 편집 UX와 AI 텍스트 기능을 기존 내부 베타 범위 안에서 확장하고, `AI_Subtitler_v1.1`(CEP 레퍼런스)의 3계층 구조·단어 타임스탬프 모델과의 정합성을 확인·문서화한다.
>
> **Project**: shortflow-studio (ShortFlow Studio)
> **Version**: 1.0.0
> **Author**: seunghooda-dev
> **Date**: 2026-07-13
> **Status**: Draft

---

## 1. Overview

### 1.1 Purpose

사용자가 참고 프로젝트로 제시한 `C:/Users/seung/Desktop/AI_Subtitler_v1.1`(Adobe CEP 기반 자막 플러그인)의 구조와 기능 중, ShortFlow Studio(UXP 기반) 내부 베타에 실제로 반영할 가치가 있는 항목을 선별해 계획한다. 사용자가 가장 참고 가치가 높다고 지목한 두 가지는 **(a) Premiere 조작·파일/네트워크 처리·UI를 분리한 3계층 구조**와 **(b) 단어 타임스탬프 기반 자막 편집 모델**이다.

### 1.2 Background

리포지토리 조사 결과, 아래 두 가지 핵심 사항은 **ShortFlow Studio에 이미 구현되어 있다**:

1. **3계층 유사 구조**: `index.ts`(UI 글루) / `src/premiere.ts`(Premiere UXP host 조작) / `src/*.ts` 어댑터 모듈(예: `src/asset-library.ts` 파일 IO, `src/openai-text.ts` 네트워크·AI) 로 이미 역할이 분리되어 있다. CEP의 Node 영역과 달리 UXP는 host 권한 모델이 다르므로 완전히 동일한 구조는 아니지만, "Premiere 조작"과 "파일/네트워크"와 "UI"를 분리한다는 원칙은 이미 적용 중이다.
2. **단어 타임스탬프 자막 모델**: [src/subtitles.ts](../../../src/subtitles.ts)에 `cueId`/`wordId` 안정 식별자, 중복·정규화·정렬 불변식 검증, `splitCue`/`mergeCues`, 실제 단어 시간이 없을 때의 글자 수 비례 보간(`proportionalWords`), 행/단어 단위 `hidden` 처리가 이미 구현되어 있다(레퍼런스보다 검증 로직이 더 엄격함). 이 항목은 `docs/INTERNAL_BETA_SCOPE.md`의 포함 범위에도 이미 명시돼 있다.

Design 단계 착수 시 추가로 확인한 결과, 참고 목록의 **단어 클릭→playhead 이동**과 **재생 중 현재 단어 자동 하이라이트**도 이미 [src/subtitle-controller.ts](../../../src/subtitle-controller.ts)의 `seekToWord()`/`updatePlayhead()`와 [index.ts](../../../index.ts)의 `onSeek`/폴링 연결로 완전히 구현돼 있음을 확인했다(FR-01/FR-02, §3.1 참고). 따라서 이번 Plan은 "처음부터 구현"이 아니라 **① 실제로 비어 있는 기능 갭만 선별해 확장**하고 **② 이미 있는 구조적 장점을 컨벤션으로 명문화**하는 데 초점을 둔다.

레퍼런스 목록 중 일부(AI 이미지·영상 생성 전체 파이프라인, 썸네일 AI 자동 보정)는 `docs/INTERNAL_BETA_SCOPE.md`의 **후순위 범위**에 이미 명시되어 있어 이번 Plan에서 제외했다(§2.2 참고). 클립 모션/키프레임 기능은 기존 범위 문서에 포함·제외 어느 쪽으로도 명시되지 않은 완전 신규 영역이라 별도 결정 항목으로 분리했다(§8).

### 1.3 Related Documents

- 참고 소스(레포 외부, 읽기 전용 참고용): `C:/Users/seung/Desktop/AI_Subtitler_v1.1/com.jamak.cep/`
- 현재 자막 모델: [src/subtitles.ts](../../../src/subtitles.ts), [src/subtitle-controller.ts](../../../src/subtitle-controller.ts)
- 현재 AI 텍스트: [src/openai-text.ts](../../../src/openai-text.ts) (현재 `reflow`/`review`/`translate` 3종, 60cue 단위 배치 처리 `chunkSubtitleCues` 이미 존재)
- 범위 기준 문서: [docs/INTERNAL_BETA_SCOPE.md](../../INTERNAL_BETA_SCOPE.md), [docs/ROADMAP.md](../../ROADMAP.md)
- 프로젝트 커밋/푸시 컨벤션: 중간 커밋·push 없이 `npm run check` 통과 후 체크포인트 커밋 1회, GitHub push는 마일스톤 시점 1회만 (ROADMAP.md "실행 원칙")

---

## 2. Scope

### 2.1 In Scope

- [x] ~~자막 단어 ↔ 재생헤드 연동 UX~~ → 조사 결과 이미 완전히 구현·연결되어 있음(§1.2, FR-01/FR-02). Design 단계에서 동작 재검증만 수행하고 신규 설계 대상에서 제외
- [ ] AI 텍스트 액션 확장(기존 `reflow`/`review`/`translate`의 안전장치(엔드포인트 고정, API 키 처리, timeout/abort, 2MB 배치 제한, prompt-injection 방어)는 재사용하되, 아래 3종은 자막 문서를 변형하는 것이 아니라 **읽기 전용으로 파생 데이터를 생성**하는 별도 응답 스키마가 필요함 — 상세는 Design 문서 참고):
  - 인터뷰 핵심 발언 추출(interview-highlight)
  - 편집 구성안 생성(edit-outline)
  - 유튜브 제목/설명/태그 생성(youtube-metadata) — 자막 텍스트 기반, 실제 업로드 자동화 아님
  - 레퍼런스 보드 프롬프트 메모 보강(prompt-enrich) — 텍스트만 개선, 이미지/영상 생성 호출 없음(허용 범위 내 "프롬프트 메모·태그·출처 기록"에 해당)
- [ ] 3계층 분리 원칙과 기존 모듈 매핑을 `CLAUDE.md` 또는 아키텍처 노트로 문서화(신규 코드 작성 시 host-bridge/adapter/UI 경계를 지키기 위한 컨벤션 정리)

### 2.2 Out of Scope

다음은 사용자가 언급한 참고 목록에 포함되어 있으나, `docs/INTERNAL_BETA_SCOPE.md` "후순위 범위"에 이미 명시되어 있어 **이번 Plan에서 제외**한다. 별도로 범위 자체를 바꾸기로 결정하지 않는 한 구현하지 않는다.

- AI 이미지 생성·편집·배경 제거·업스케일 실행 파이프라인, 이미지/텍스트 기반 영상 생성, 영상 4K 업스케일 → "AI 이미지·영상 생성 전체 파이프라인" 후순위
- 썸네일 AI 화질 개선·배경 제거 자동화, AI 대화형 보정 → "썸네일 AI 대화 수정·A/B 자동 판단" 후순위
- 고급 비트 매칭·자동 덕킹 고도화 → 기존 로드맵에서 이미 제외 명시
- 다국어 패키지, 스마트 리프레임, 업로드 패키지 자동 생성 → 기존 로드맵에서 이미 제외 명시

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | ~~자막 편집기에서 단어를 클릭하면 Premiere playhead를 해당 단어 시작 시간으로 이동한다~~ | High | **Done (기존 구현 확인)** — [src/subtitle-controller.ts](../../../src/subtitle-controller.ts) `seekToWord()`가 `options.onSeek`을 호출하고, [index.ts:2035](../../../index.ts) `onSeek: (seconds) => setSequencePlayerPosition(seconds)`로 이미 연결됨. Design 단계에서는 재검증만 수행 |
| FR-02 | ~~재생 중 현재 재생 위치에 해당하는 단어를 자막 편집기에서 자동으로 하이라이트한다~~ | Medium | **Done (기존 구현 확인)** — `subtitle-controller.ts` `updatePlayhead(seconds)`가 `findActiveSubtitle()`로 활성 단어/큐에 `is-active`·`aria-current`를 부여하고 [index.ts:603](../../../index.ts)에서 폴링 결과로 이미 호출됨 |
| FR-03 | AI 텍스트 액션에 `interview-highlight`(인터뷰 핵심 발언 추출)를 추가한다 | Medium | Pending |
| FR-04 | AI 텍스트 액션에 `edit-outline`(편집 구성안 생성)을 추가한다 | Medium | Pending |
| FR-05 | AI 텍스트 액션에 `youtube-metadata`(제목/설명/태그 생성)를 추가한다 | Medium | Pending |
| FR-06 | 레퍼런스 보드 프롬프트 메모에 `prompt-enrich`(AI 프롬프트 보강, 생성 호출 없음) 액션을 추가한다 | Low | Pending |
| FR-07 | host-bridge(`src/premiere.ts`) / 파일·네트워크 어댑터(`src/*.ts`) / UI(`index.ts`) 3계층 분리 컨벤션을 문서화한다 | Medium | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| 원문 보존 | 신규 AI 액션도 기존 `review`/`reflow`와 동일하게 원문 자막 텍스트가 임의로 변형되지 않았는지 응답 후 검증 | 기존 `openai-text.ts` 검증 패턴 재사용 + 단위 테스트 |
| 입력 안전성 | 신규 액션도 JSON 스키마 강제 응답, 60cue/240word 배치 상한, prompt-injection 방어(`safeTargetLanguage`류 패턴) 적용 | 코드 리뷰 + 단위 테스트 |
| 비용/한도 | 신규 AI 액션 4종 추가로 인한 OpenAI 호출 증가를 `provider-unit` 일일 한도·AI 작업 큐 정책에 반영 | `src/ai-queue-controller.ts`, `src/job-queue.ts` 검토 |
| 회귀 방지 | 기존 `npm run check`(typecheck+lint+build+test) 전체 통과 | CI 없음 — 로컬 `npm run check` |
| 재생 연동 | playhead 이동은 Premiere 공개 UXP API 경계만 사용(QE DOM 등 비공식 API 금지) | `src/premiere.ts` 코드 리뷰 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] FR-01~FR-07 구현 완료
- [ ] Mock/순수 로직 테스트 추가 및 `npm test` 통과
- [ ] `npm run check`(typecheck·lint·build·test) 전체 통과
- [ ] 신규 AI 액션에 대해서도 원문 비변형·배치 상한·prompt-injection 방어 테스트 포함
- [ ] Design 문서(`subtitle-ai-enhancements.design.md`) 작성 완료

### 4.2 Quality Criteria

- [ ] `npm run lint` 0 오류
- [ ] `npm run build` 및 `verify:dist` 통과
- [ ] 신규 기능 관련 실제 Host smoke는 별도 게이트로 `docs/HOST_BETA_RUNBOOK.md`에 추가 기록(Mock 통과를 Host 승인으로 대체하지 않음)

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 재생 중 현재 단어 추적이 잦은 playhead polling으로 UI/host 성능 저하 유발 | Medium | Medium | 기존 대용량 재생 추적 최적화 패턴(README 언급) 재사용, polling 주기 제한 |
| 신규 AI 액션 4종이 OpenAI 호출량·비용을 늘려 provider-unit 일일 한도를 초과 | Medium | Medium | AI 작업 큐의 dedupe/재시도/동시 실행 제한에 신규 액션 편입, 한도 재산정 |
| 신규 액션의 JSON 스키마·원문 비변형 검증을 기존 3종과 다르게 구현해 일관성이 깨짐 | Medium | Low | `openai-text.ts`의 기존 `action` 판별·검증 로직을 확장하는 방식으로만 구현(신규 파일 분리 지양) |
| 참고 프로젝트의 QE DOM 의존·파일명 기반 항목 탐색·단일 지점 트랙 탐색 패턴이 실수로 유입 | High | Low | 코드 리뷰에서 명시적으로 배제(§1.2, 사용자 원 메시지 "그대로 복사하면 안 되는 부분" 반영) — 경로 기반 식별, 전체 구간 충돌 검사, 잠긴 트랙 검사, 실패 롤백 유지 |
| 모션/키프레임 등 범위 미확정 항목이 이번 스프린트에 섞여 들어와 내부 베타 일정 지연 | Medium | Low | §8 별도 결정 항목으로 명확히 분리, 이번 Plan 구현 범위에서 제외 |

---

## 6. Architecture Considerations

### 6.1 프로젝트 성격

ShortFlow Studio는 웹앱이 아닌 **Adobe Premiere Pro UXP host 플러그인**이라 템플릿의 Starter/Dynamic/Enterprise(웹앱 기준) 분류가 직접 맞지 않는다. 참고용으로 `.pdca-status.json`에는 `Dynamic`으로 기록돼 있으나, 실제 구조는 프레임워크 없는 TypeScript + UXP DOM + 커스텀 controller 모듈 구성이다.

### 6.2 Key Architectural Decisions (현재 스택 기준)

| Decision | 현재 값 | 비고 |
|----------|---------|------|
| UI 레이어 | `index.ts` + `public/index.html`/`styles.css`, 프레임워크 없는 vanilla TS/DOM | CEP 레퍼런스의 `main.js` 역할과 유사하나 기능별 controller로 이미 분리됨 |
| Host 조작 | `src/premiere.ts` (Premiere UXP DOM, `lockedAccess()` 트랜잭션) | CEP `index.jsx`(ExtendScript) 대응, 공개 API 경계만 사용 |
| 파일/네트워크 어댑터 | `src/asset-library.ts`(파일), `src/openai-text.ts`/`src/speech.ts`(네트워크·AI) | CEP `replicate.js`/Node 파일 처리 대응 |
| 상태/컨트롤러 | `src/subtitle-controller.ts`, `src/thumbnail-controller.ts`, `src/automation-controller.ts` 등 기능별 controller | 단일 `main.js` 방식 지양 — 이미 분리돼 있음 |
| AI 텍스트 클라이언트 | `OpenAITextClient`(`src/openai-text.ts`), JSON 강제 스키마, 60cue 배치 | 확장 대상(FR-03~06) |
| 테스트 | Node 기반 mock 테스트(`scripts/run-tests.mjs`, `tests/*.test.ts`) | Jest/Vitest 아님 — 기존 자체 러너 유지 |

### 6.3 3계층 원칙 요약 (문서화 대상, FR-07)

```
UI (index.ts, public/)
  → 파일·네트워크 어댑터 (src/asset-library.ts, src/openai-text.ts, src/speech.ts ...)
  → Premiere host 조작 (src/premiere.ts, lockedAccess() 트랜잭션 내부)
```

신규 기능은 이 경계를 넘나들지 않는다. 예: AI 텍스트 신규 액션은 `openai-text.ts`(어댑터)에만 추가하고 `index.ts`는 호출·렌더링만 담당한다.

---

## 7. Convention Prerequisites

### 7.1 Existing Project Conventions

- [x] `docs/ROADMAP.md`/`docs/INTERNAL_BETA_SCOPE.md`에 범위·컨벤션 존재(중간 커밋 금지, Mock/Host 게이트 분리 등)
- [ ] `CLAUDE.md` — 아직 없음. 3계층 컨벤션(§6.3)을 이 Plan의 Design 단계에서 `CLAUDE.md`에 정리하는 것을 권장
- [x] ESLint 설정(`eslint.config.mjs`), TypeScript strict(`tsconfig.json`) 존재

### 7.2 Conventions to Define/Verify

| Category | Current State | To Define | Priority |
|----------|---------------|-----------|:--------:|
| AI 액션 네이밍 | 존재(`reflow`/`review`/`translate`) | 신규 4종 액션명 규칙 통일(kebab-case, 동사형 지양) | Medium |
| Host 호출 경계 | 존재(`lockedAccess()` 패턴) | playhead 이동/현재 단어 추적도 동일 패턴 준수 | High |
| 문서화 위치 | 없음 | 3계층 원칙을 `CLAUDE.md`에 명문화 | Medium |

### 7.3 Environment Variables Needed

신규 환경 변수 없음. 기존 `OPENAI_API_KEY`(UXP secureStorage 저장, `verify:speech:live`에서만 프로세스 환경변수로 사용) 정책을 그대로 따른다.

### 7.4 Pipeline Integration

이 프로젝트는 bkit 9-phase 웹앱 파이프라인이 아닌 자체 4주 로드맵(`docs/ROADMAP.md`)을 사용 중이므로 Phase 1/2 문서 생성은 생략하고, 대신 이 Plan → Design → Do → Check 흐름만 로드맵 "2주차/3주차" 항목과 병행한다.

---

## 8. 별도 결정이 필요한 항목 (이번 Plan 범위 밖)

- **클립 모션/키프레임**(위치·크기·회전·불투명도 제어, 방향별 등장·퇴장, easing/spring 키프레임): 참고 목록에 있었으나 `docs/ROADMAP.md`의 "내부 베타 필수 기능" 11개 항목에도, `INTERNAL_BETA_SCOPE.md` 포함/후순위 어느 목록에도 없는 완전 신규 영역이다. 내부 베타 일정(한 달) 안에 포함할지 여부는 사용자 판단이 필요하며, 포함하기로 결정되면 별도 `/pdca plan clip-motion-keyframes`로 분리해 진행을 권장한다.

---

## 9. Next Steps

1. [ ] 사용자에게 §2.2(제외 범위)와 §8(모션/키프레임 별도 결정) 확인받기
2. [ ] `/pdca design subtitle-ai-enhancements`로 설계 문서 작성
3. [ ] 설계 승인 후 구현 시작

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-07-13 | 최초 작성 | seunghooda-dev (Claude Code) |
