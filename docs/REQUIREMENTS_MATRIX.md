# ShortFlow Studio 요구사항 추적표

기준일: 2026-07-11

상태 정의:

- **패널 연결**: `index.ts`가 컨트롤러/함수를 초기화하거나 실행합니다.
- **엔진 준비**: 소스와 자동 테스트는 있으나 현재 패널 초기화에 연결되지 않았습니다.
- **자동 검증**: Node mock/순수 테스트 또는 build verifier가 통과했습니다.
- **호스트 미검증**: Premiere Pro/UXP/Media Encoder 실제 실행 증거가 없습니다.

현재 `npm test` 결과는 821/821 통과입니다. 이 숫자는 Premiere 호스트 검증을 뜻하지 않습니다.

| ID | 요구사항 | 구현 파일 | 자동 근거 | 패널/배포 상태 | Premiere 호스트 |
|---|---|---|---|---|---|
| R-001 | Manifest v5, Premiere 25.6+, UXP 패널/권한 | `public/manifest.json`, `scripts/verify-dist.mjs` | `npm run verify:dist` | 배포 구조 | 미검증 |
| R-002 | 시퀀스명/파일명, 시간 범위, 플랫폼 프로필, 기본 QC | `src/core.ts` | `tests/core.test.ts` | 패널 연결 | 미검증 |
| R-003 | Premiere 상태/QC, 복제 숏폼, 마커, MOGRT, export/cover | `src/premiere.ts`, `index.ts` | `tests/premiere.test.ts` | 패널 연결 | 미검증 |
| R-004 | 안전한 설정 기본값과 범위 정규화 | `src/settings.ts` | `tests/settings.test.ts` | 패널 연결 | 미검증 |
| R-005 | persistent token 자산 루트, 기본 폴더, 재귀 sync/검색 | `src/asset-library.ts`, `index.ts` | `tests/asset-library.test.ts` | 패널 연결 | 미검증 |
| R-006 | 이미지/영상 레퍼런스, 정렬, 최대 100개, AI 입력 최대 4개 | `src/references.ts`, `src/reference-controller.ts` | `tests/references.test.ts` | 패널 연결 | 미검증 |
| R-007 | GPT Image 2 편집, OpenAI 공식 origin 강제, secureStorage, redaction | `src/ai.ts`, `src/settings.ts`, `index.ts` | `tests/ai.test.ts`, `tests/settings.test.ts` | 패널 연결 | 미검증 |
| R-008 | 4레이어/6레이아웃 썸네일, Canvas 렌더, PNG/AI 결과 | `src/thumbnail.ts`, `src/thumbnail-controller.ts` | `tests/thumbnail.test.ts` | 패널 연결 | 미검증 |
| R-009 | TTS 4,096자, voice/model/속도/형식, 음성 저장/삽입 | `src/speech.ts`, `src/speech-files.ts`, `src/speech-controller.ts` | `tests/speech.test.ts`, `tests/speech-files.test.ts` | 패널 연결 | 미검증 |
| R-010 | STT 25MB, 지원 형식, diarized transcript/SRT | `src/speech.ts`, `src/speech-files.ts`, `src/speech-controller.ts` | `tests/speech.test.ts`, `tests/speech-files.test.ts` | 패널 연결 | 미검증 |
| R-011 | 자막 단어/큐 편집, SRT, autosave, undo/redo | `src/subtitles.ts`, `src/subtitle-controller.ts`, `index.ts` | `tests/subtitles.test.ts`, `tests/subtitle-controller.test.ts` | 패널 연결 | 미검증 |
| R-012 | 무음 컷/펀치 계획과 Premiere 적용 어댑터 | `src/automation.ts`, `src/automation-controller.ts`, `src/premiere.ts` | `tests/automation.test.ts`, `tests/premiere.test.ts` | 패널 연결 | 미검증 |
| R-013 | YouTube Shorts/Reels/TikTok Safe Zone | `src/safe-zone.ts`, `src/automation-controller.ts` | `tests/safe-zone.test.ts` | 패널 연결 | 미검증 |
| R-014 | 브랜드 키트 20개, JSON, 파일 token, 자막/썸네일/TTS/MOGRT 기본값 | `src/brand-kit.ts`, `src/brand-kit-controller.ts` | `tests/brand-kit.test.ts` | 패널 연결 | 미검증 |
| R-015 | AI 큐 5종, 동시성/취소/재시도/캐시/일일 provider-unit 예산 | `src/job-queue.ts`, `src/ai-queue-controller.ts` | `tests/job-queue.test.ts` | 패널 연결 | 미검증 |
| R-016 | clone-before-mutation, 50개 저널, rollback/interrupted 복구 | `src/recovery.ts`, `index.ts` | `tests/recovery.test.ts` | 패널 연결 | 미검증 |
| R-017 | 최종 QC snapshot, hard-block/waiver, JSON/Markdown report와 export gate | `src/final-qc.ts`, `src/final-qc-controller.ts`, `index.ts` | `tests/final-qc.test.ts` | 패널 연결 | 미검증 |
| R-018 | 진단, API guard, 익명 bundle, telemetry 명시적 opt-in | `src/diagnostics.ts`, `index.ts` | `tests/diagnostics.test.ts`, `tests/ui-contract.test.ts` | 패널 연결 | 미검증 |
| R-019 | API key 비밀 저장, error/report redaction, HTTPS/SSRF 방어 | `src/ai.ts`, `src/speech.ts`, `src/diagnostics.ts`, `src/final-qc.ts` | 관련 `ai`, `speech`, `diagnostics`, `final-qc` 테스트 | 혼합 | 미검증 |
| R-020 | CCX 루트 manifest, dist 안전검증, 재현 가능한 SHA-256, 덮어쓰기 보호 | `scripts/verify-dist.mjs`, `scripts/package-ccx.mjs`, `package.json` | `npm run build`, `npm run package:ccx` | 서명 전 후보 | 해당 없음 |
| R-021 | Windows/macOS 설치 및 업데이트 | `README.md`, `docs/QA_CHECKLIST.md` | 문서 검토만 | 미완료 | 미검증 |
| R-022 | AI 음성 고지·개인정보·telemetry 동의 | `README.md`, `src/diagnostics.ts` | `tests/diagnostics.test.ts` | 정책/엔진 준비 | 미검증 |

## 릴리스 차단 항목

다음 증거가 생기기 전에는 운영 배포 완료로 표시하지 않습니다.

1. Windows와 macOS에서 Premiere Pro 25.6+ UXP Developer Tool 로드 결과
2. 실제 프로젝트에서 복제/마커/MOGRT/Media Encoder/파일 권한 회귀 테스트
3. OpenAI 이미지/TTS/STT 실제 계정 호출과 비용·고지·개인정보 검토
4. 진단 UI의 실제 UXP capability probe와 로컬 JSON bundle 검토
5. Adobe 정식 plugin ID, 서명/notarization, 조직 배포 또는 Marketplace 심사 증거
