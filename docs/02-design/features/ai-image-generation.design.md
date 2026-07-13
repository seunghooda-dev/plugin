# AI 이미지 생성 text→image (ai-image-generation) Design

> **Feature**: deferred-ai-features Phase 3 (#4 이미지 생성) · **Project**: shortflow-studio · **Date**: 2026-07-13
> **Plan**: `docs/01-plan/features/deferred-ai-features.plan.md` §3 Phase 3

## 1. 범위

프롬프트 텍스트로 이미지를 생성(text→image)해 **레퍼런스 보드**에 생성물로 추가한다. 레퍼런스 보드는 이미 AI 이미지 레퍼런스·프롬프트 메모·에셋 권리 인프라를 갖고 있어 새 표면을 만들지 않고 얹기에 자연스럽다. 영상 생성(Phase 4)은 provider·비용 결정이 필요해 별도.

두 단위로 나눈다.
- **3a (완료)**: 클라이언트 코어 `OpenAIImageClient.generateImage` — gpt-image-2 `images/generations`. 자체 완결, 단위 테스트로 검증.
- **3b (완료)**: 레퍼런스 보드 UI 와이어링 — "프롬프트로 생성" → 생성 바이트를 레퍼런스로 추가(출처=AI 생성). AI 작업 큐 예산·동의 게이트 재사용.

### 3b 구현 결정 (2026-07-13)

레퍼런스 항목은 파일(persistent token) 필수라 raw 바이트만으로는 추가 불가. 생성 바이트를 **UXP `getDataFolder()`**(플러그인 전용 폴더, 네이티브 피커 불필요)에 `ai-gen-<ts>.png`로 쓰고, 그 파일 엔트리를 `addEntries`로 추가한다. 아키텍처 규칙대로 `ReferenceController`는 `generatedImageProvider?: (prompt, size) => Promise<ReferenceFileEntry>` 포트만 선언하고 반환 엔트리를 신뢰하지 않는다(`addEntries`가 파일 형식·중복·토큰 재검증). index.ts가 AI 호출(`generateImage`, 큐·동의 게이트)과 데이터 폴더 쓰기(`writeGeneratedReferenceFile`)를 주입한다. 출처는 "AI 생성 (gpt-image-2)", 태그 "ai-생성" 기본. UI는 레퍼런스 폼에 프롬프트 textarea + size select(1:1/3:2/2:3) + "이미지 생성" 버튼(`.ai-gen-controls` flex — grid 붕괴 회피). 단위 테스트 2개(생성물 추가·빈 프롬프트 가드).

## 2. 3a 설계 — generateImage

기존 `editImage`의 안전 플럼빙을 그대로 재사용한다(HTTPS `api.openai.com` 핀, secureStorage 전용 키, timeout/abort, 재시도, 응답 PNG 검증). 편집이 아니라 생성이므로 입력 이미지가 없고 `images/generations`(JSON 본문)로 간다.

```ts
export interface ImageGenerateRequest {
  prompt: string;
  size?: "1024x1024" | "1536x1024" | "1024x1536"; // 기본 1024x1024
  timeoutMs?: number;
}
async generateImage(request: ImageGenerateRequest): Promise<Uint8Array>
```

- 프롬프트: `cleanPrompt`(NFKC·제어문자·`<>` 제거, 4096자 캡)로 정제, 빈 값이면 생성 전용 에러("생성할 이미지를 설명하는 프롬프트를 입력해 주세요.").
- size: 소규모 allowlist(gpt-image-2 지원값), 벗어나면 에러, 미지정 시 `1024x1024`.
- 본문: `{model: gpt-image-2, prompt, size, quality:"high", output_format:"png", n:1}` JSON.
- 응답: `payload.data[0].b64_json` → `decodeBase64` → `assertPngResponse`(편집 경로와 동일 계약, 50MB 캡). 없으면 `INVALID_RESPONSE`.
- 실패: `throwApiError`로 상태·재시도성 판정 재사용(`insufficient_quota` 비재시도 포함).

편집 경로(`editImage`)의 에러 메시지 계약은 테스트로 고정돼 있으므로 건드리지 않는다. 생성은 별도 메서드로 추가만 한다.

## 3. 검증 (3a)

- 단위(`ai.test.ts`): 빈/과길이 프롬프트 거부, size allowlist, 정상 200 → PNG 바이트, 비-PNG 응답 거부, b64 없음 거부, 429 insufficient_quota 비재시도. 기존 `inputImage`/fetch 스텁 하네스 재사용.
- 게이트 `npm run check` green.
- Host: 3b 와이어링 후 실제 gpt-image-2 200으로 레퍼런스 추가 확인(사용자 프롬프트 입력 필요).

## 4. 한계·후속

- 3b UI·권리 기록·큐 예산은 다음 단위.
- 영상 생성(Phase 4)은 provider/비용 미정 — 사용자 결정 전 착수하지 않는다.
