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

## 4. 검증 계획
- 게이트: `npm run check` (1437 기준 유지, 실패 0).
- 수동 회귀 포인트(다음 Host 세션): 복구 저널 목록 렌더, 복제 제거 확인 모달, 진단 실행.
