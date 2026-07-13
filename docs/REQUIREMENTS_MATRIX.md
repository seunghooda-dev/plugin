# ShortFlow Studio 내부 베타 요구사항 추적표

기준일: 2026-07-11

현재 목표와 고정 개발 순서는 [내부 베타 로드맵](ROADMAP.md), 상세 범위는 [내부 베타 범위](INTERNAL_BETA_SCOPE.md)를 기준으로 합니다.

상태 정의:

- **필수**: 내부 베타 완료 조건
- **부분**: 기존 구현이 있으나 내부 베타 요구사항 일부가 남음
- **후순위**: 현재 구현·확장하지 않음
- **자동/mock**: Node 순수 테스트·Mock Host·정적 계약 근거가 있음
- **호스트 미검증**: Premiere 실제 실행 증거가 없음

범위 재정의 전 전체 기준선은 864/864입니다. 2026-07-12 현재 변경을 포함한 `npm run check`는 `typecheck`, `lint`, `build`, dist 검증과 전체 1017/1017 테스트를 통과했습니다. CCX/SHA-256과 verified evidence는 검증된 체크포인트를 먼저 커밋하고 작업 트리가 clean인 상태에서 `npm run beta:evidence:verified`를 실행해 새로 생성해야 하며, 더티 작업 트리 산출물은 최종 증거로 사용하지 않습니다. Premiere/UXP 실제 Host 증거는 UXP 패널 로드, bootstrap, UDT watch/reload 가능 상태, 빈 프로젝트·활성 시퀀스 없음 상태의 안전한 안내, QC 정상 실패 처리, 테스트 MP4 import, 활성 시퀀스 생성, 테스트 클립 삽입, 기본 QC, 최신 dist 탭 전환과 마커 탭 표시까지 제한 통과로 기록했습니다. 이후 실제 QC에서 `1080×1920`, 길이 약 `00:04`, 비디오 트랙 3개, 오디오 트랙 4개를 재확인했고, 상태 UI에서 플레이헤드와 In/Out 범위도 읽었습니다. 최종 QC 실제 Host 실행 결과는 `PASS 16 · WARNING 4 · ERROR 4`이며, frame size·aspect ratio·guide overlay·output path 네 항목이 현재 fixture의 차단 오류로 남아 있습니다. 진단은 Premiere 26.3.0과 UXP `uxp-9.3.0-local`에서 `compatible: true`를 확인했습니다. Premiere `sequence.getSelection().getTrackItems()`가 비어도 개별 TrackItem `getIsSelected()`가 true를 반환하는 Host 차이를 발견해 fallback을 구현했고, 실제 Host 패널 UI에서 `타임라인 4개 선택 · 00:06` 표시를 확인했습니다. 자동 컷은 SRT fallback dry-run, 추천 마커, 원본 보존 복제 시퀀스 적용을 실제 Host에서 확인했습니다. 무음 간격 fixture로 CUT 2개·ZOOM 2개가 분석되고 복제본에 `SF CUT 01/02`·`SF ZOOM` 마커가 배치됨을 확인했으며, 복제 준비 실패 정리와 클립 경계 펀치인 키프레임은 회귀 테스트로 보강했습니다. 캡션 트랙 없음 경고는 SRT 삽입 전 정상 경고로 기록합니다. TTS live/API 삽입은 최종 승인 전 [runbook](HOST_BETA_RUNBOOK.md)에 따라 다시 확인합니다. 썸네일 Canvas는 Premiere Pro 26.3 UXP에서 `drawImage`/텍스트/파일 export API가 부족해 현재 Host에서는 PNG/JPG 내보내기 UI를 비활성화하고 이미지 data URL을 내장하는 SVG fallback 저장 버튼을 제공합니다. Safe Zone 오버레이는 Canvas 없이 BMP로 생성되며 실제 Host에서 ShortFlow 가이드 에셋 import와 프로그램 모니터 표시까지 확인했습니다. SRT 파일 import는 실제 파일 선택창으로 자막 편집기에 2개 cue가 로드됨을 확인했고, 음악/SFX는 실제 폴더 동기화, WAV A1 삽입, Premiere 소스 모니터 미리듣기·자동 재생을 확인했습니다. 공개 UXP API에는 caption track item 생성 API가 없어 SRT는 파일 저장·프로젝트 가져오기까지를 보장합니다.

2026-07-12 후속 dirty 후보에는 Adobe 공식 폴더용 빈 확장자 `""`을 사용한 명시적 폴더 열기와 `media-picker` fallback, 썸네일 출력 폴더 persistent token, 파괴적 복구 확인의 fail-closed 처리가 구현됐습니다. 관련 asset-library·thumbnail-controller·recovery 테스트는 test compile 후 88/88 통과했습니다. 이 문단의 세 항목은 코드·자동/mock 단계이며 위 1017/1017 체크포인트 이후 변경입니다. 최신 전체 `npm run check`, `dist` reload와 실제 Premiere Host 검증 전에는 Host 통과로 보지 않습니다.

| ID | 요구사항 | 내부 베타 | 구현 파일/예정 | 자동 근거 | Premiere 호스트 |
|---|---|---|---|---|---|
| R-001 | Premiere UXP host bridge, 버전/capability guard | 필수 | `public/manifest.json`, `src/premiere.ts`, `index.ts` | `tests/premiere.test.ts`, dist verifier. Premiere 26.3 Action factory/`lockedAccess()` 경계 포함. 폴더용 `""`과 명시적 미디어 확장자만 허용하고 `*`·`exe`는 거부하는 manifest 계약 추가 | 기존 UXP 로드·bootstrap 제한 통과. 변경된 폴더 launch 권한의 reload·동의창은 Host 재검증 필요 |
| R-002 | 시퀀스 상태, 시간 범위, 기본 QC | 필수 | `src/core.ts`, `src/premiere.ts`, `index.ts`, `public/index.html` | `tests/core.test.ts`, `tests/premiere.test.ts`, UI 계약 테스트. QC 내부 상태 스트립 추가 | 빈 프로젝트·시퀀스 없음 감지 통과, 활성 시퀀스 기본 QC 제한 통과. 플레이헤드·In/Out Host 상태 UI 확인. 현재 Host에서 `1920×1080` 시퀀스를 `1080×1920` 불일치로 잡고 길이·트랙 수를 표시함. 선택 클립 smoke와 QC 내부 스트립 시각 확인 필요 |
| R-003 | clone-before-mutation, 마커·오디오·MOGRT·cover/export 경계 | 필수 | `src/premiere.ts`, `src/recovery.ts`, `index.ts` | Premiere/recovery mock | 자동/mock 통과. 실제 자동 컷 적용에서 원본 보존, 복제 시퀀스 생성·활성화, CUT/ZOOM 마커 배치 통과 |
| R-004 | 안전한 설정 기본값·정규화·프로젝트별 저장 | 필수 | `src/settings.ts`, `src/subtitle-controller.ts` | settings/subtitle 테스트 | 자동/mock 통과. 실제 Host 저장·복구 동작은 최종 UX pass에서 재확인 |
| R-005 | 음악/SFX 루트, 기본 폴더, 재귀 sync, 검색, 폴더 카테고리, 순서 저장, 미리듣기, 타임라인 삽입 | 필수 | `src/asset-library.ts`, `index.ts` | `tests/asset-library.test.ts`, UI 계약 테스트. Music/SFX 하위 폴더를 카테고리로 추출하고 드롭 삽입은 현재 동기화 snapshot의 오디오만 허용. 명시적 `allowFolderLaunch`와 allowlisted audio `media-picker` fallback 결과 계약 추가 | `host-smoke-assets` 동기화, A1 삽입, Premiere 소스 모니터 미리듣기·자동 재생은 Host 통과. 폴더 직접 열기와 picker fallback은 Host 재검증 필요 |
| R-006 | 레퍼런스 보드, 외부 이미지/영상, 메모·태그·출처·폴더 정리 | 필수 | `src/references.ts`, `src/reference-controller.ts` | `tests/references.test.ts`, UI 계약 테스트. source/tags/notes가 검색과 prompt 메타데이터에 반영되고 path/token은 제외됨 | Host 파일 권한 재검증 필요 |
| R-007 | AI 이미지·영상 생성 전체 파이프라인 | 후순위 | 기존 코드 유지, 추가 확장 금지 | 기존 회귀만 유지 | 해당 없음 |
| R-008 | 1280×720 수동 썸네일, 1~4분할, 변형·효과, PNG/JPG | 필수 | `src/thumbnail.ts`, `src/thumbnail-controller.ts` | thumbnail·UI 계약 테스트. Canvas가 막힌 Host를 위한 보안 검증 SVG fallback, MIME sniff, data URL 내장, 빈 레이어 1280×720 SVG와 출력 폴더 token 저장·다음 controller 재사용 테스트 추가 | UXP Canvas `drawImage`/text/export 미지원과 버튼 상태만 Host 확인. SVG 실제 파일·내용, persistent output token 재사용·만료 복구는 Host pending이며 PNG/JPG 승인 대체는 아님 |
| R-009 | TTS 기본 생성·저장·타임라인 삽입 | 필수 | `src/speech.ts`, `src/speech-files.ts`, `src/speech-controller.ts`, `index.ts` | Mock Host adapter·요청 snapshot·stale guard 테스트. TTS/STT floating panel flex-wrap UI 계약 포함 | Host UI 접근성 통과. TTS 카드, 저장 폴더, 자동 삽입 옵션, 오디오 트랙 입력, 생성 버튼 확인. 실제 API 호출·파일 생성·삽입 smoke 필요 |
| R-010 | STT 25MB 경계, timed transcript, SRT 저장 | 필수 | speech 모듈·controller | 응답 상한·정렬·폴더 snapshot 테스트 | SRT 파일 import 부분 Host 통과. 실제 STT live/API는 별도 필요 |
| R-011 | 단어/큐 자막 편집, strict autosave, undo/redo, 비동기 경합 방지 | 필수 | `src/subtitles.ts`, `src/subtitle-controller.ts`, `index.ts` | subtitle/controller 테스트 | 시퀀스 없음 fallback 초기화 통과, 편집 smoke 필요 |
| R-012 | 발화 보호 무음 컷 마커와 기본 펀치인 | 필수 | `src/automation.ts`, `src/automation-controller.ts`, `src/automation-transcript.ts`, `src/premiere.ts` | automation/host mock, SRT→automation transcript fallback 테스트 | SRT fallback 입력·입력 없음 안전 차단·복제 시퀀스 적용 Host 통과. 무음 간격 SRT에서 CUT 2개와 ZOOM 2개 마커 확인 |
| R-013 | 보수적 revision Safe Zone overlay·기본 정렬 | 필수 | `src/safe-zone.ts`, `src/automation-controller.ts`, `src/premiere.ts`, `index.ts` | safe-zone/final-qc/automation-controller mock, BMP byte renderer와 UI 계약 테스트 | BMP overlay Host 통과. 실제 Premiere에서 ShortFlow 가이드 에셋 import와 프로그램 모니터 표시 확인 |
| R-014 | 브랜드 키트·마케팅 프리셋 확장 | 후순위 | 기존 코드 유지 | 기존 회귀만 유지 | 해당 없음 |
| R-015 | 고급 AI queue/provider orchestration | 후순위 | 기존 기반만 유지 | 기존 회귀만 유지 | 해당 없음 |
| R-016 | 설정·autosave·복구 저널·rollback/interrupted 복구 | 필수 | `src/settings.ts`, `src/recovery.ts`, `index.ts` | settings/recovery 테스트. 파괴적 복구 확인 함수 부재·거절·예외·비 boolean 응답은 false, 명시적 boolean true만 허용하는 fail-closed 회귀 추가 | 저널 영속성과 원본 보존은 일부 Host 통과. fail-closed 확인 UI와 실제 복제본 rollback·원본 보존은 Host 재검증 필요 |
| R-017 | 내부 QC, 권리 경고, JSON/Markdown 로컬 리포트 | 필수 | `src/final-qc.ts`, `src/asset-rights.ts` | final-qc·asset-rights 테스트 | 최종 QC Host 실행 통과. 테스트 시퀀스 `PASS 16 · WARNING 4 · ERROR 4`; 권리 금지·만료 검사는 pass. JSON/Markdown 저장은 추가 확인 필요 |
| R-018 | 사용자 실행 로컬 진단 로그·redaction | 필수 | `src/diagnostics.ts`, `index.ts` | diagnostics/UI 계약 | Host 통과. Premiere 26.3.0, UXP `uxp-9.3.0-local`, `compatible: true`; 익명 JSON 저장과 현재 fixture 민감 패턴 0건 확인 |
| R-019 | API key·경로·오류 redaction, HTTPS/SSRF 방어 | 필수 | AI/speech/diagnostics/final-qc | 관련 보안 테스트, `npm run verify:speech` dry-run 증거 | 자동/mock 통과. Host 진단 JSON 음성 검사 통과. 합성 민감값 능동 redaction과 live API는 추가 검증 |
| R-020 | 재현 가능한 내부 베타 CCX·SHA-256·민감 파일 검사 | 필수 | packaging/verifier scripts | verified evidence는 clean committed worktree를 요구하고 Git commit/tree를 기록하도록 보강 | 검증된 체크포인트 커밋 후 `npm run beta:evidence:verified` 재실행 필요 |
| R-021 | Windows/macOS 실제 설치 | 호스트 준비 후 | README/QA | 체크리스트 | 미검증·보류 |
| R-022 | AI 전송 동의·AI 음성 고지·개인정보 | 필수 | settings/UI/index | settings/UI 테스트 | 자동/mock 통과. 실제 live API 실행 전 Host UI 고지와 사용자 동의 재확인 필요 |
| R-023 | 출처·라이선스·상업 사용·만료일·출처 표기 | 필수 | `src/asset-rights.ts`, `index.ts`, asset panel UI | asset-rights·UI 계약 테스트 | Host UI 재검증 필요 |
| R-024 | 내보내기 전 권리 경고와 JSON/Markdown 권리 리포트 | 필수 | `src/asset-rights.ts`, `src/final-qc.ts`, `index.ts` | asset-rights·final-qc·UI 계약 테스트 | Host 최종 QC 재검증 필요 |
| R-025 | 음악/SFX 카테고리·드래그 순서·미리듣기 | 필수 | `src/asset-library.ts`, `index.ts`, `public/index.html` | asset-library·UI 계약 테스트. UXP binary read·128MB 제한·현재 sync snapshot 파일 검증, `system-folder`/`media-picker` 결과와 취소·확장자 불일치 거부 포함 | 오디오 2개 동기화, 드래그 순서 저장/원복, Premiere 소스 모니터 미리듣기·자동 재생, 재렌더 후 카드 수 2개 유지는 Host 통과. 새 폴더 열기 경로는 pending |
| R-026 | 썸네일 수동 기능과 내보내기 경로 | 필수 | `src/thumbnail.ts`, `src/thumbnail-controller.ts` | thumbnail·UI 계약 테스트. 로컬/mock PNG/JPG와 Host SVG fallback 분리, 공통 출력 폴더 resolver와 persistent token 저장·재사용 자동 근거 | UXP Canvas export 미지원과 SVG 버튼 활성까지 Host 확인. 실제 SVG 저장·내용 및 token 재사용·만료 복구는 pending; PNG/JPG 정식 승인은 별도 렌더 경로 확보 후 판정 |

## 현재 구현하지 않는 후순위 요구사항

| 요구사항 | 처리 |
|---|---|
| 결제·라이선스·플랜 제한 | 13단계 이후 |
| 자동 텔레메트리 서버 | 13단계 이후. 내부 베타는 로컬 진단만 사용 |
| AI 이미지·영상 생성 전체 파이프라인 | 후순위. 내부 베타는 외부 파일 레퍼런스만 사용 |
| 썸네일 AI 대화 수정 | 후순위 |
| 고급 BGM 비트 매칭·자동 덕킹 | 후순위 |
| 다국어 패키지 | 15단계 |
| 스마트 리프레임·피사체 추적 | 14단계 |
| 플랫폼별 업로드 패키지 자동 생성 | 18단계 이후 검토 |
| 썸네일 A/B 자동 판단 | 구현 약속하지 않음 |
| 상용 SaaS 계정·서버·결제 | 13단계 이후 |

## 내부 베타 로컬 후보 차단 항목

1. 실제 Premiere 프로젝트에서 TTS live/API 삽입을 재확인하지 않은 상태
2. 실제 Premiere 프로젝트에서 권리 경고, 썸네일 SVG 저장·출력 폴더 token 복구, 폴더 launch/fallback, fail-closed rollback과 최종 QC snapshot을 재확인하지 않은 상태
3. `typecheck`, `lint`, `test`, `build` 중 하나라도 실패
4. CCX 산출물 무결성 또는 SHA-256 불일치

실제 Premiere 내부 베타 승인은 위 로컬 후보와 별개로 host 설치 후 다시 판정합니다.
