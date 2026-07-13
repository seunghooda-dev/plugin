# index.ts 모듈 분리 (index-modularization) Design Document

> **Planning Doc**: [index-modularization.plan.md](../../01-plan/features/index-modularization.plan.md)
> **Date**: 2026-07-13 · **Status**: Phase 1 구현

## 1. 원칙

- **이동+주입만, 동작 변경 0.** 함수 본문은 그대로 옮기고, index.ts 전역 참조만 팩토리 옵션 파라미터로 치환한다.
- import 방향은 `index.ts → src/모듈` 단방향. 추출 모듈은 `src/ui.ts`(공용 DOM 유틸)와 자기 도메인 어댑터만 import한다.
- 가변 전역은 **getter로 주입** — 예: `getManager: () => RecoveryManager | null`. 부팅 순서(전역이 bootstrap에서 늦게 할당됨)에 안전.

## 2. Phase 1 설계

### 2.1 `src/text-encoding.ts` (신규)
- 이동 대상: `encodeUtf8`, `decodeUtf8`, `FallbackTextEncoder/Decoder` 클래스들, `installTextEncodingPolyfill()` (index.ts 123~217행 부근).
- index.ts는 `import { installTextEncodingPolyfill } from "./src/text-encoding";` 후 **기존과 같은 위치(최상단)에서 즉시 호출** — 폴리필 적용 시점 보존.
- 의존성: 없음(전역 globalThis만 접근). 테스트: 신규 `tests/text-encoding.test.ts`는 두지 않는다(동작 불변 이동이며 폴리필 경로는 ui-contract·기존 스모크로 간접 검증, 필요 시 후속).

### 2.2 `src/recovery-panel.ts` (신규)
```ts
export interface RecoveryPanelOptions {
  getManager: () => RecoveryManager | null;                    // 전역 게터 주입 (MR-01)
  removeClone: (sourceId: string, cloneId: string, name: string) => Promise<void>; // premiere 어댑터
  onActivity: (level: "info" | "warning" | "success", message: string) => void;
  onError: (error: unknown, context: string) => void;
  toast: (message: string, level?: "info" | "success" | "warning" | "error") => void;
}
export function createRecoveryPanel(options: RecoveryPanelOptions): { render(): void }
```
- 이동 대상: `recoveryStatusLabel`, `UxpRecoveryDialogElement`, `recoveryRollbackPending`(팩토리 클로저 상태로), `requestRecoveryRollbackConfirmation`, `renderRecoveryJournal`→`render`, `rollbackRecoveryEntry`(내부화).
- index.ts 변경: bootstrap에서 `recoveryPanel = createRecoveryPanel({...})` 생성, 기존 `renderRecoveryJournal()` 호출 3곳(1962·1972·2049)을 `recoveryPanel.render()`로 치환. `confirmDestructiveRecovery`/`removeVerifiedClonedSequence` import는 모듈로 이동.
- DOM id(`recovery-list`, `recovery-count`, `recovery-confirm-*`)는 src/*.ts 전체를 스캔하는 ui-contract 계약이 자동 유지 (MR-03).

## 3. 이후 Phase 개요 (구현은 별도 커밋)
- Phase 2 `diagnostics-panel`: `diagnosticsReport` 상태를 모듈 내부로, `localDiagnosticsContext`가 읽는 recovery 항목은 `getRecoveryEntries()` getter 주입.
- Phase 3 asset-browser / ai-settings, Phase 4 markers·QC / bootstrap 슬리밍 — 동일 패턴.

## 3b. Phase 3b `src/asset-browser-panel.ts` 구현 기록 (2026-07-13)

- **패널이 소유하는 상태**: `assets`, `assetOrder`, `assetPreviewUrl`, `selectedAssetId`, `assetLibrary` — 전부 팩토리 클로저로 이동. index.ts가 읽던 곳은 읽기 접근자 `getAssets()` / `getSelectedAssetId()` / `getSelectedAsset()`로 치환(최종 QC 스냅숏 `currentAssetRightsRecords`, `localDiagnosticsContext`, 권리 저장 `handleSaveAssetRights`, 소스 모니터 미리듣기 검증).
- **index.ts에 남긴 것과 이유.**
  - 에셋 권리 레지스트리(`assetRightsRegistry`, `sessionGeneratedAssetRightsIdsByProject`, `currentAssetRightsRecords`, `renderAssetRights`, `handleSaveAssetRights`)는 최종 QC·TTS 자동 기록·레퍼런스와 공유되고 ui-contract 소스 계약이 해당 문자열을 고정하므로 이동하지 않음. 패널에는 `ensureRightsRegistry`(load용)와 `renderRights` 콜백만 주입.
  - `previewAssetInPremiereSourceMonitor`는 `require("premierepro")` Host 호출이라 index.ts에 유지하고 `previewInSourceMonitor` 콜백으로 주입. 이 함수의 자산 검증은 `getAssets()`, 폴백 열기는 패널 `openAssetFile()` 접근자를 사용.
  - Premiere 타임라인 삽입은 `insertToTimeline`(= `importAndInsertAsset`)로 주입 — 패널은 premiere.ts를 import하지 않는다.
- **부팅 순서 주의**: 기존 bootstrap 1행의 `assetOrder = loadAssetOrder()`는 패널 `initialize()` 첫 줄로 이동(라이브러리 복원과 같은 시점). 그 사이 구간(applySettingsToUI·bindCoreEvents)은 assetOrder를 읽지 않으므로 관찰 가능한 동작 차이 없음.
- **ui-contract**: 결합 소스 검사 목록(line 690대)에 `src/asset-browser-panel.ts` 추가.

## 4. 검증 계획
- 게이트: `npm run check` (1437 기준 유지, 실패 0).
- 수동 회귀 포인트(다음 Host 세션): 복구 저널 목록 렌더, 복제 제거 확인 모달, 진단 실행.
