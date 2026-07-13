# 후순위 AI 기능 당김 (deferred-ai-features) Planning Document

> **Summary**: 사용자 지시로 INTERNAL_BETA_SCOPE의 후순위 #4·#5·#6을 당겨 구현한다 — AI 이미지·영상 생성, 썸네일 AI 대화 수정·A/B 판단, BGM 비트 매칭·자동 덕킹.
>
> **Project**: shortflow-studio · **Date**: 2026-07-13 · **Status**: Phase 1 구현 중

## 1. 배경·범위 변경

2026-07-13 사용자 지시: "후순위로 명시한 것 중 4·5·6번을 진행한다." 이는 `docs/INTERNAL_BETA_SCOPE.md`가 **후순위(구현하지 않음)**로 명시한 다음을 당기는 **의도적 범위 확장**이다.

- **#4 AI 이미지·영상 생성 전체 파이프라인**
- **#5 썸네일 AI 대화 수정·A/B 자동 판단**
- **#6 고급 BGM 비트 매칭·자동 덕킹**

범위 문서(`INTERNAL_BETA_SCOPE.md`, `ROADMAP.md`)의 후순위 목록에서 해당 항목을 "진행"으로 옮기고, 각 구현 완료 시 갱신한다.

## 2. 현재 코드 상태 (중요)

- **썸네일 이미지 AI는 이미 완전히 코딩·와이어링돼 있고 UI만 숨겨져 있다.** `OpenAIImageClient.editImage`(gpt-image-2), 프리셋 `basic/vivid/upscale/remove-bg/**chat**`, `handleThumbnailAI`, `onAIRequest` 연결 전부 존재. 숨김은 `public/index.html`의 `<div class="thumb-ai-card" hidden>` + `thumb-ai-preset-select`/`thumb-ai-prompt-input`의 `disabled` + `ui-contract.test.ts`의 계약 3개(`528~530`)로 고정.
- **AI 이미지 생성(text→image)·영상 생성은 코드 없음.** editImage는 편집 전용. 생성은 신규.
- **BGM 비트 매칭·덕킹은 코드 없음.** 신규 오디오 분석.

## 3. 단계 (위험·의존 순)

| Phase | 내용 | 규모 | 상태 |
|---|---|---|---|
| **1** | **썸네일 이미지 AI 숨김 해제 + 실제 gpt-image-2 Host 검증** (basic/vivid/upscale/remove-bg/chat) — #5의 편집·대화 부분 | 소(코드 존재, 속성·계약·문서만) | 완료(UI) |
| **1b** | **Canvas 비의존 입력 경로** — Host에서 합성 대신 선택 레이어 원본 바이트를 gpt-image-2 입력으로 | 소~중 | 구현 완료·Host 검증 대기 |
| 2 | #5 A/B 자동 판단 — 썸네일 변형 2~3종 생성·비교 UI. 자동 "판정"은 약속하지 않고 나란히 보여주는 수동 선택부터 | 중 | 대기 |
| 3 | #4 AI 이미지 생성(text→image) — `OpenAIImageClient`에 생성 메서드 추가, 프롬프트→이미지, 레퍼런스/썸네일 연계 | 중~대 | **완료 · Host 통과(실제 gpt-image-2 200→레퍼런스 추가, runbook §25-i)** |
| 4 | #4 AI 영상 생성 — OpenAI **Sora**(sora-2) 영상 API로 text→video, 레퍼런스 보드 추가. 4K 업스케일 제외 | 대 | **완료(생성)·UI Host 검증**(실제 Sora 생성은 비용·수 분이라 사용자 게이트) |
| 5 | #6 BGM 비트 매칭·자동 덕킹 — Web Audio 비트 검출, 발화 구간 기반 자동 볼륨 덕킹 | 대 | 대기 |

각 Phase는 독립 게이트(`npm run check`)+커밋. Phase 4·5는 규모가 커 각각 별도 Plan/Design 문서를 권장한다.

## 4. Phase 1 상세 (지금)

### 변경
- `public/index.html`: `.thumb-ai-card`의 `hidden` 제거, `thumb-ai-preset-select`·`thumb-ai-prompt-input`의 `disabled` 제거.
- `tests/ui-contract.test.ts` 528~530: "hidden/disabled 유지" 계약을 "노출/활성" 계약으로 뒤집는다(같은 커밋).
- `docs/INTERNAL_BETA_SCOPE.md`·`docs/ROADMAP.md`: 썸네일 AI 편집을 후순위에서 활성 범위로 이동, "AI 대화 수정"은 chat 프리셋으로 제공됨을 명시(A/B 자동 판단은 Phase 2로 남김).
- `thumbnail-controller.ts`의 `card?.hidden` 런타임 가드는 유지 — 카드가 노출되면 자연히 통과.

### 검증
- `npm run check` green (1515/1515). — 완료(커밋 2770114)
- 실제 Premiere Host CDP 검증 완료: UI 숨김 해제는 성공(카드 노출·preset/prompt/run 활성·제목 "AI 이미지 보정", 콘솔 오류 0).

### ⚠️ Host 검증에서 드러난 블로커 (Phase 1b로 분리)

실제 실행 시 `detectCanvasLimit()`가 발동해 **"현재 환경에서는 썸네일 AI 입력 이미지를 만들 수 없습니다 — Premiere UXP Canvas가 이미지 합성/텍스트 렌더링/PNG·JPG 내보내기 미지원"** 토스트로 차단됨. 이는 PNG/JPG 내보내기가 비활성인 것과 **동일한 근본 원인** — gpt-image-2에 넘길 입력 PNG 바이트를 UXP Canvas가 만들지 못한다. 따라서 UI를 켜도 현재 Host에서 실제 AI 보정은 실행되지 않는다.

**Phase 1b (설계 필요)**: Canvas 비의존 입력 경로. 후보 — (a) 합성 캔버스 대신 선택 레이어의 **원본 이미지 바이트**를 gpt-image-2 입력으로 사용(합성/텍스트 오버레이는 편집 후 재적용), (b) SVG fallback을 서버 없이 래스터화할 방법 탐색(현재 없음). (a)가 유력하나 "무엇을 편집하는가"(합성본 vs 원본)가 바뀌므로 별도 Design 문서로 다룬다.

**→ Phase 1b 구현 완료 (2026-07-13)**: 설계는 `docs/02-design/features/thumbnail-ai-canvas-independent.design.md`. (a)안 채택 — `runAI`가 `detectCanvasLimit()`이면 upfront throw 대신 선택(없으면 첫) 레이어의 원본 바이트(history item bytes 또는 persistent token read)를 mime/filename과 함께 AI에 넘긴다. `onAIRequest` 포트를 `ThumbnailAIInput{bytes,mimeType,filename}`으로 바꿔 Host에서 원본이 JPEG/WebP여도 실을 수 있게 했다(Canvas 없이 PNG 변환 불가). Canvas 정상 환경은 기존대로 합성 PNG를 편집한다. 단위 테스트 2개 추가(원본 바이트 전달·레이어 없음 안내), `npm run check` green. **남은 것**: 실제 Premiere에서 import→basic 실행→gpt-image-2 200으로 새 레이어 추가 Host 검증.

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| gpt-image-2 편집 경로가 실제 Host에서 처음 실행 — 이번 세션의 queueMicrotask류 Host 전용 버그 가능 | Phase 1 Host 검증에서 실제 200 응답까지 확인 |
| 범위 확장이 내부 베타 일정과 충돌 | 위험·규모 순 단계화, 영상 생성·BGM은 별도 Plan |
| 이미지·영상 생성 비용 | 기존 AI 작업 큐 provider-unit 예산·동의 게이트 재사용 |
