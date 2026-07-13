# index.ts 모듈 분리 (index-modularization) Planning Document

> **Summary**: 2,234줄 단일 컴포지션 루트 `index.ts`를 도메인별 wiring 모듈로 단계적으로 분리해, 서로 다른 기능 작업이 같은 파일에서 충돌하지 않게 만든다.
>
> **Project**: shortflow-studio · **Date**: 2026-07-13 · **Status**: Draft

## 1. Purpose / Background

2026-07-13 병렬 작업 분석에서 `src/` 계층은 이미 도메인 모듈로 분리돼 있으나 **모든 이벤트 바인딩·컨트롤러 와이어링·host 헬퍼가 index.ts 한 파일에 집중**되어, UI가 걸리는 어떤 기능 작업도 병렬화가 불가능함을 확인했다(사용자 지시서의 "병렬화 핵심 걸림돌"). 목표는 상용 리팩터가 아니라 **내부 베타 개발 속도**를 위한 최소 분리다.

## 2. Scope

### In Scope (단계별)
- [ ] **Phase 1**: `src/text-encoding.ts`(폴리필, 결합 0) + `src/recovery-panel.ts`(복구 저널 UI, 의존성 주입 팩토리) 추출
- [ ] **Phase 2**: `src/diagnostics-panel.ts` (진단 실행/렌더/내보내기 — recovery 저널 getter 주입 필요)
- [ ] **Phase 3**: 에셋 브라우저 섹션(최대 덩어리), AI 설정 섹션
- [ ] **Phase 4**: 마커/QC/숏폼 생성 섹션, bootstrap 슬리밍
- 각 Phase는 독립 게이트(`npm run check`)+커밋 단위. 한 Phase씩만 진행.

### Out of Scope
- 동작 변경·기능 추가 없음(순수 이동+주입). Premiere API 경계(`src/premiere.ts`) 변경 없음.
- 프레임워크 도입, 이벤트 버스 등 새 아키텍처 없음.

## 3. Requirements

| ID | Requirement | 검증 |
|----|-------------|------|
| MR-01 | 추출 모듈은 index.ts 전역을 직접 참조하지 않고 팩토리 옵션(콜백/getter)으로 주입받는다 | 코드 리뷰 — import 방향은 index.ts→모듈 단방향 |
| MR-02 | 동작 불변 — 전체 게이트 green 유지, dist 산출물 동작 동일 | `npm run check` + Host 스모크(다음 Host 세션) |
| MR-03 | `tests/ui-contract.test.ts`의 소스 계약(DOM id 스캔은 src/*.ts 전체를 읽으므로 자동 유지, index.ts 한정 정규식 계약은 해당 코드가 index.ts에 남아 있는 동안 불변) 유지 | 게이트 |
| MR-04 | 새 파일 첫 줄 한국어 역할 주석 (CLAUDE.md 컨벤션) | 리뷰 |

## 4. Risks

| Risk | 완화 |
|------|------|
| 전역 가변 상태(recoveryManager 등)를 모듈이 스냅샷으로 캡처해 stale 참조 | 값이 아니라 **getter 주입**(`getManager: () => RecoveryManager \| null`) |
| ui-contract의 index.ts 정규식 계약 파괴 | Phase별로 계약 대상 함수(safe-zone overlay, startPanel 등)는 index.ts에 유지, 이동 시 테스트도 같은 커밋에서 갱신 |
| 폴리필 순서 변화(installTextEncodingPolyfill은 모듈 로드 시 즉시 실행) | index.ts 최상단 import 직후 명시 호출로 순서 보존 |
