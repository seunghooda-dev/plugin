# 썸네일 AI Canvas 비의존 입력 (thumbnail-ai-canvas-independent) Design

> **Feature**: deferred-ai-features Phase 1b · **Project**: shortflow-studio · **Date**: 2026-07-13
> **Plan**: `docs/01-plan/features/deferred-ai-features.plan.md` §4 Phase 1b

## 1. 문제

Phase 1에서 썸네일 이미지 AI(gpt-image-2 basic/vivid/upscale/remove-bg/chat) UI를 노출했으나, 실제 Premiere 26.3 UXP Host에서 실행하면 `detectCanvasLimit()`가 발동해 차단된다. 근본 원인은 UXP `<canvas>`가 `drawImage`/`fillText`/`toBlob`/`toDataURL`을 제공하지 않아 **합성 미리보기를 PNG 바이트로 래스터화할 수 없다**는 것 — PNG/JPG 내보내기가 막힌 것과 동일한 원인이다. `runAI()`는 이 경우 upfront throw 한다(`thumbnail-controller.ts:1125-1129`).

## 2. 설계 결정 — 무엇을 편집하는가

Canvas 유무에 따라 AI 입력 소스를 분기한다.

| 환경 | AI 입력 | 편집 대상 |
|---|---|---|
| Canvas 정상 (브라우저·Mock) | `renderCanvas()` → `canvasToPngBytes(합성)` | **합성 썸네일**(레이어+텍스트+효과) — 기존 동작 유지 |
| Canvas 제한 (Premiere Host) | 선택(없으면 첫) 레이어의 **원본 이미지 바이트** | **단일 원본 이미지**(합성 전) |

편집 대상이 "합성본 → 원본 단일 이미지"로 바뀐다. 이는 의도적이며, 실제로 편집 프리셋(배경 제거·화질 개선·기본/강렬 보정)은 **원본 사진에 적용하는 것이 더 자연스럽다**. 결과는 두 경로 모두 `addAIResult`로 **새 레이어**에 추가되므로, 사용자는 원본 위에 보정 결과를 얹어 계속 합성할 수 있다. 텍스트·배지 오버레이 자동 재적용은 범위에 넣지 않는다(Phase 2 이후).

## 3. 원본 바이트 확보 경로 (Canvas 불필요)

`svgHrefForLayer()`가 SVG fallback용으로 이미 쓰는 것과 동일한 소스 해석을 재사용하되, data URL이 아니라 **raw 바이트**를 반환한다. 검증된 SVG export 경로를 건드리지 않기 위해 `svgHrefForLayer`를 리팩터링하지 않고 병렬 헬퍼를 추가한다(약 10줄 중복, 위험 회피 목적).

Host 실경로 두 분기만 처리한다.
- **history item**(생성물, `kind:"generated"`) — `historyItems[].bytes`(PNG) 직접 사용.
- **file token**(import, `kind:"file"`) — `getEntryForPersistentToken(record.token)` → `entry.read` → `inferThumbnailImageMime`로 mime 판정.

그 외(blob URL·data URL만 있고 토큰 없음)는 Host 실경로가 아니므로 `null` 반환 → 명확한 안내 메시지. import 레이어는 항상 토큰을 가진다(`thumbnail-controller.ts:724-735`).

mime는 png/jpeg/webp만 통과시킨다(썸네일 import 필터 `THUMBNAIL_FILE_TYPES`와 `editImage`의 허용 집합이 이 셋). `image/gif` 등은 `null` → 편집 불가. filename은 mime에서 합성(`thumbnail-source.<ext>`)해 `editImage`의 확장자·mime 일치 검증(`ai.ts:356-360`)을 항상 통과시킨다.

## 4. 포트 시그니처 변경

`onAIRequest`가 바이트만 받으면 mime를 실을 수 없다(Host에서 원본이 JPEG/WebP일 수 있고, Canvas가 없어 PNG로 변환 불가). 입력 서술 객체로 바꾼다.

```ts
export interface ThumbnailAIInput {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly filename: string;
}
onAIRequest?: (input: ThumbnailAIInput, preset: string, prompt: string) => MaybePromise<ThumbnailAIResult>;
```

`index.ts`의 `handleThumbnailAI`는 하드코딩된 `image/png`/`shortflow-thumbnail.png` 대신 `input.bytes/mimeType/filename`을 사용한다(합성 경로도 이 객체로 동일하게 넘어온다). 호출부는 컨트롤러 1곳(`runAI`)뿐이고, 테스트는 `onAIRequest`를 스텁하지 않아 blast radius가 작다.

## 5. 검증

- 단위: Canvas 제한 어댑터 + 토큰 기반 레이어로 `runAI` 실행 → `onAIRequest`가 원본 bytes·mime·filename을 받고, 결과가 새 레이어로 추가되는지. 레이어 0개면 명확한 에러.
- 게이트: `npm run check` green.
- Host: 실제 Premiere에서 이미지 import → basic 프리셋 실행 → gpt-image-2 200 응답으로 새 레이어 추가 확인(quota 해소·키 저장 상태). 10MB 초과 원본은 `editImage`가 명확히 거부(허용, 별도 축소는 후속).

## 6. 한계·후속

- 10MB 초과 원본은 클라이언트 검증에서 거부된다(사전 축소 없음 — Canvas 없이는 리사이즈 불가, 후속 과제).
- 합성본이 아닌 단일 원본을 편집하므로 텍스트/배지가 결과에 반영되지 않는다 — 사용자가 결과 레이어 위에 오버레이를 다시 얹는다.
