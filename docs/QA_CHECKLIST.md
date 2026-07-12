# ShortFlow Studio Premiere 내부 베타 QA 체크리스트

이 문서는 자동 검사, 정적/Mock Host 검사와 실제 Premiere 호스트 검사를 분리합니다. 현재 합격 범위는 [내부 베타 범위](INTERNAL_BETA_SCOPE.md), 개발 순서는 [로드맵](ROADMAP.md)을 기준으로 합니다. 상용화·고급 AI 후순위 기능은 내부 베타 차단 조건이 아닙니다.

최종 체크포인트 커밋 직전에는 이 상세 문서 전체를 다시 훑기 전에 [내부 베타 체크포인트 체크리스트](BETA_RELEASE_CHECKLIST.md)를 먼저 사용해 차단 조건을 빠르게 확인합니다.

## 0. 증거 등급

- **A — 자동 게이트**: 명령 출력으로 재현 가능한 TypeScript/ESLint/Node/Vite/패키지 검사
- **M — mock/순수 테스트**: Premiere/UXP 어댑터를 가짜 객체로 검증한 결과
- **H — host 테스트**: 실제 Premiere Pro/UXP/Media Encoder/파일 시스템에서 사람이 확인한 결과

범위 재정의 전 기준선은 `npm test` 864/864 통과입니다. 2026-07-12 현재 변경을 포함한 `npm run check`는 `typecheck`, `lint`, `build`, dist 검증과 전체 1017/1017 테스트를 통과했습니다. 검증 증거와 CCX/SHA-256은 검증된 체크포인트를 먼저 커밋하고 작업 트리가 clean인 상태에서 `npm run beta:evidence:verified`를 실행해 새로 생성해야 하며, 더티 작업 트리에서 만든 산출물은 최종 증거로 사용하지 않습니다. 실제 Premiere/UXP smoke에서는 패널 로드, bootstrap, UDT watch/reload 가능 상태, 빈 프로젝트·활성 시퀀스 없음 상태 안내, QC 정상 실패 처리, 테스트 MP4 import, 활성 시퀀스 생성, 테스트 클립 삽입, 기본 QC, 최신 dist 탭 전환과 마커 탭 표시를 확인했습니다. 이후 실제 Host에서 `1080×1920`, 길이 약 `00:04`, 비디오 트랙 3개, 오디오 트랙 4개 QC를 재확인했고, 상태 UI에서 플레이헤드와 In/Out 범위도 읽었습니다. 최종 QC 실제 Host 실행 결과는 `PASS 16 · WARNING 4 · ERROR 4`이며, frame size·aspect ratio·guide overlay·output path 네 항목이 현재 fixture의 차단 오류로 남아 있어 내부 베타 승인을 뜻하지 않습니다. 진단은 Premiere 26.3.0과 UXP `uxp-9.3.0-local`에서 `compatible: true`를 확인했습니다. 캡션 트랙 없음 경고는 SRT 삽입 전 정상 경고로 기록합니다. Premiere `sequence.getSelection().getTrackItems()`가 비어도 개별 TrackItem `getIsSelected()`가 true를 반환하는 Host 차이를 발견해 트랙 스캔 fallback을 구현했고, 관련 Premiere mock 테스트와 실제 Host 패널 UI `타임라인 4개 선택 · 00:06` 표시를 확인했습니다. 자동 컷은 SRT fallback dry-run, 추천 마커, 원본 보존 복제 시퀀스 적용을 실제 Host에서 확인했습니다. 무음 간격 fixture로 CUT 2개·ZOOM 2개가 분석되고 복제본에 `SF CUT 01/02`·`SF ZOOM` 마커가 배치됨을 확인했으며, 복제 준비 실패 정리와 클립 경계 펀치인 키프레임은 회귀 테스트로 보강했습니다. 이 결과는 4주차 최종 승인 게이트를 대신하지 않으며 TTS live/API 삽입은 최종 승인 전 Host에서 다시 확인합니다. Premiere Pro 26.3 UXP Canvas는 현재 썸네일 PNG/JPG export에 필요한 `drawImage`/text/export 기능이 부족하므로 코드가 PNG/JPG 내보내기 UI를 비활성화하고 이미지 data URL을 내장하는 SVG fallback 저장 버튼을 제공합니다. Safe Zone 오버레이는 Canvas 없이 BMP로 생성되며 실제 Host에서 ShortFlow 가이드 에셋 import와 프로그램 모니터 표시까지 확인했습니다. SRT 파일 import는 실제 파일 선택창으로 자막 편집기에 2개 cue가 로드됨을 확인했고, 음악/SFX는 실제 폴더 동기화, WAV A1 타임라인 삽입, Premiere 소스 모니터 미리듣기·자동 재생을 확인했습니다. 공개 UXP API에는 caption track item 생성 API가 없어 SRT는 파일 저장·프로젝트 가져오기까지를 보장합니다.

## 내부 베타 범위 게이트

현재 구현·검증 대상으로 삼는 항목입니다.

- [x] Mock Host 기반 Premiere bridge와 비파괴 mutation 경계
- [x] 자막/STT/SRT 모델, 단어 타임스탬프 편집, strict autosave와 undo/redo
- [x] TTS/STT 요청·파일 저장·삽입 어댑터의 로컬/mock 경계
- [x] 음악/SFX 폴더 동기화·카테고리·순서 이동·미리듣기·타임라인 삽입 mock 경계
- [x] 에셋 출처·라이선스·상업 사용·만료·출처 표기와 권리 경고/리포트
- [x] 수동 썸네일 1280×720 편집과 PNG/JPG 내보내기 로컬 경계
- [x] Safe Zone overlay·기본 정렬 변경의 mock 통합 검증
- [x] 발화 보호 자동 컷 마커와 기본 펀치인 mock 경계
- [x] 설정·자동저장·복구·사용자 실행 로컬 진단의 내부 베타 통합 검토
- [x] 현재 변경을 포함한 `typecheck`, `lint`, `test`, `build`와 dist 최종 검증. 전체 1017/1017 통과
- [ ] 남은 Host gate 통과와 자동 게이트 성공 후 검증된 체크포인트 커밋 생성
- [ ] clean committed worktree에서 `npm run beta:evidence:verified`를 실행해 CCX·SHA-256·증거를 새로 생성

다음은 현재 게이트에서 제외합니다: 결제/라이선스, SaaS 계정·서버, 자동 텔레메트리 서버, AI 이미지·영상 생성 전체 파이프라인, 썸네일 AI 대화·A/B 판단, 고급 비트 매칭·자동 덕킹, 다국어, 스마트 리프레임, 업로드 패키지 자동화.

아래 세부 체크리스트 중 내부 베타 범위를 벗어난 항목은 기존 회귀 참고 또는 후속 배포 준비용이며 현재 완료를 막지 않습니다.

## 1. 릴리스 기록

- [ ] 릴리스 버전:
- [ ] commit 또는 소스 스냅샷 식별자:
- [ ] 테스트 담당자/승인자:
- [ ] Windows 버전과 CPU 아키텍처:
- [ ] macOS 버전과 CPU 아키텍처(Intel/Apple Silicon):
- [ ] Premiere Pro 버전(25.6 이상):
- [ ] Media Encoder 버전:
- [ ] UXP Developer Tool 버전(2.2 이상):
- [ ] 테스트 프로젝트와 미디어 세트:
- [ ] CCX 파일명/SHA-256:

## 2. A — 자동 품질 게이트

- [x] 범위 재정의 전 기준선 `npm test` 864/864를 통과했습니다.
- [ ] 새 릴리스 소스에서 Node.js 20.19+ `npm install`이 성공합니다.
- [x] `npm run typecheck`가 성공합니다(2026-07-11 현재 작업 트리).
- [x] 1주차 Mock 기준선에서 `npm run lint`가 성공했습니다. 최종 소스에서 다시 실행합니다.
- [x] 현재 변경을 포함한 `npm test`가 1017/1017로 통과했고 테스트 수 감소가 없습니다.
- [x] 1주차 Mock 기준선에서 `npm run build`와 dist 검증이 성공했습니다. 최종 소스에서 다시 실행합니다.
- [x] 현재 변경을 포함한 `npm run check`가 1017/1017로 성공했습니다.
- [x] `npm run beta:evidence`가 최신 Host gate 체크리스트 기준의 증거 템플릿을 생성하는 경로를 제공합니다.
- [x] `npm run beta:evidence:verified`는 clean committed worktree를 요구하고 Git commit/tree를 기록하도록 보강했습니다.
- [ ] 남은 Host gate와 자동 게이트를 통과한 체크포인트를 커밋한 뒤, clean worktree에서 `npm run beta:evidence:verified`를 실행해 최종 증거를 생성합니다.
- [x] `npm run verify:speech`가 dry-run 증거 파일을 생성합니다. 최신 증거: `speech-evidence/ShortFlow_Speech_Evidence_20260712T111256Z.md`
- [x] `npm run verify:speech:local`이 로컬 `openai-whisper` base/cpu smoke에서 2개 segment, 9개 word timestamp, 생성 샘플 키워드 4/4를 확인했습니다. 최신 증거: `local-whisper-evidence/20260712T110447Z/ShortFlow_Local_Whisper_Evidence_20260712T110447Z.md`. 이 검증은 OpenAI live API, TTS 생성, Premiere Host 오디오 삽입 gate를 대체하지 않습니다.
- [ ] API key 사용 승인 시 `npm run verify:speech:live`가 실제 TTS→STT smoke 증거 파일을 생성합니다.
- [x] `dist/manifest.json`은 manifest v5, `premierepro`, 최소 25.6.0입니다.
- [x] package/manifest 버전이 일치합니다.
- [x] `dist`에 심볼릭 링크, `.env`, 인증서/private key, credentials/secret 파일과 250MB 초과 단일 파일이 없습니다.
- [x] manifest network domain은 wildcard·인증정보·query 없는 HTTPS origin입니다.
- [x] manifest `launchProcess` 권한은 `file` scheme과 내부 베타 미디어 확장자 allowlist로 제한됩니다.
- [x] HTML이 로컬 `styles.css`/`index.js`를 참조하고 아이콘이 존재합니다. 내부 베타 `dist`에는 source map을 포함하지 않습니다.

## 3. M — mock/순수 모듈 범위

- [x] core/설정/파일명/시간 범위와 기본 QC 테스트가 있습니다.
- [x] Premiere 공개 API 어댑터의 정상·누락 API·경로·트랙 경계 테스트가 있습니다.
- [x] 자산/레퍼런스 persistent token, 취소·만료·중복·입력 상한 테스트가 있습니다.
- [x] 레퍼런스 보드에서 이미지/영상 AI prompt 참고 선택과 이미지 입력 4개 경계 테스트가 있습니다.
- [x] GPT Image 2 multipart, HTTPS/SSRF, timeout/retry, base64, key redaction 테스트가 있습니다.
- [x] TTS/STT 요청 형식, 4,096자/25MB, voice/model/format과 SRT 테스트가 있습니다.
- [x] 자막 편집/undo/redo/autosave/DOM 상한 테스트가 있습니다.
- [x] SRT 가져오기 입력 크기, cue 수와 총 텍스트 상한 테스트가 있습니다.
- [x] 손상 autosave/직렬화 JSON의 스키마·프로젝트 키·32Mi 문자 상한과 cue/word 정렬 검증 테스트가 있습니다.
- [x] 오래된 AI 결과, 겹치는 프로젝트 load, 초기화 중 dispose, reflow 출력 상한과 STT 교체 undo 회귀 테스트가 있습니다.
- [x] 재생 추적이 cue 존재 확인을 위해 전체 자막 문서를 복제하지 않는 통합 계약 테스트가 있습니다.
- [x] 썸네일 reducer/layout/Canvas/PNG fallback 테스트가 있습니다.
- [x] Premiere UXP Canvas export 차단 시 후속 저장 경로에 연결할 수 있는 SVG fallback 렌더러, href 보안, MIME sniff와 data URL 내장 테스트가 있습니다.
- [x] 자동 편집 계획과 Safe Zone 계산 테스트가 있습니다.
- [x] 짧은 실제 발화를 minKeep 컷에 흡수하지 않고 cut/keep이 원본 전체를 정확히 분할하는 테스트가 있습니다.
- [x] malformed STT 시간 거부, transcript 변경 무효화, 분석·마커·적용 중복 차단과 실패 후 UI 복구 테스트가 있습니다.
- [x] 컷+펀치인 합산 500개 통과/501개 거부, host 범위 검증과 실패 clone 공식 제거 transaction mock 테스트가 있습니다.
- [x] 자동 컷 계획 수 상한과 Safe Zone revision label 테스트가 있습니다.
- [x] Premiere 26.3 호환을 위해 Action 생성을 `lockedAccess()` 내부 factory로 지연하는 mock/source 회귀 테스트가 있습니다.
- [x] 브랜드 키트 validation/import/token/max 20 테스트가 있습니다.
- [x] AI queue retry/cancel/dedupe/cache/budget/restore 테스트가 있습니다.
- [x] 복구 저널 상태 전이/rollback/interrupted/직렬화 테스트가 있습니다.
- [x] 최종 QC hard-block/waiver/JSON/Markdown/입력 상한 테스트가 있습니다.
- [x] 최종 QC Safe Zone 판정 메시지에 플랫폼 가이드 revision이 포함되는지 테스트가 있습니다.
- [x] 진단 redaction/API guard/telemetry opt-in·allowlist·retry 테스트가 있습니다.

M 통과만으로 실제 UXP method 이름, Premiere 프로젝트 mutation, 코덱, Canvas 구현과 OS 권한을 보증하지 않습니다.

## H — Premiere 설치 직후 필수 smoke 12개

상세 절차와 차단 조건은 [실제 Host Smoke Runbook](HOST_BETA_RUNBOOK.md)을 따릅니다.

- [x] UXP 패널 Add/Load/Reload/닫기·재열기 제한 확인
- [x] Mock Host와 실제 Host adapter 전환 안전성 제한 확인
- [x] 빈 프로젝트·활성 시퀀스 없음 감지 확인
- [x] UDT `Watching` 상태에서 최신 `dist` load/reload 가능 확인
- [x] 테스트 MP4 프로젝트 import 확인
- [x] 현재 프로젝트·활성 시퀀스 감지 — 테스트 시퀀스 `시퀀스 01`에서 QC가 프레임/트랙/길이를 읽음
- [x] QC 탭 내부 상태 스트립 정적 연결 — 상단 상태 영역이 floating panel에서 밀릴 때를 대비해 시퀀스/프레임/길이/재생 위치/선택 요약을 QC 패널 내부에도 연결했습니다. Host 시각 확인은 추가 필요합니다.
- [x] 작은 floating panel Automation 탭 카드 가시성 재검증 — `flex-wrap` 레이아웃과 workspace 내부 스크롤 보강 후 실제 Host에서 Automation/Safe Zone 카드 DOM과 버튼 이벤트를 확인했습니다.
- [x] 플레이헤드 위치 읽기 — 실제 Host 상태 UI에서 `00:04` 값을 확인했습니다.
- [x] In/Out 범위 읽기 — 실제 Host 상태 UI에서 `00:00 → 00:00` 값을 확인했습니다.
- [x] 선택 클립 감지 — 2026-07-12 17:00 KST 재접속 확인에서 Premiere selection API 직접 조회 결과 `count: 0`이지만 개별 TrackItem `getIsSelected()`는 true를 반환하는 Host 차이를 확인했습니다. 코드에는 `getSelection()` empty/fail 시 video/audio track을 스캔해 `getIsSelected()` true 항목을 복구하는 fallback을 추가했습니다. 최신 `dist` reload 후 실제 패널 상태 UI가 `타임라인 4개 선택 · 00:06`으로 표시됨을 확인했습니다.
- [x] SRT 가져오기와 실제 지원 범위 확인 — `shortflow_smoke.srt`를 자막 편집기에 로드해 2개 cue 표시 확인. 공개 UXP API 제한상 캡션 트랙 자동 배치는 성공 범위에서 제외
- [ ] TTS 오디오 저장·프로젝트 가져오기·지정 트랙 삽입 — 작은 floating panel에서 TTS 카드와 생성 버튼 접근성은 Host 통과. 실제 API 호출·파일 생성·타임라인 삽입은 보류
- [x] 음악·효과음 기존 import 재사용·타임라인 삽입 — `SFX/shortflow_smoke.wav` 동기화 후 Premiere 프로젝트 import와 A1 타임라인 삽입 확인
- [ ] 썸네일 PNG/JPG 내보내기 경로 처리 — Premiere Pro 26.3 UXP Canvas fallback 필요. SVG fallback 저장 버튼은 연결됐지만 PNG/JPG Host export 대체 승인은 아님
- [x] 자동 컷·펀치인 적용 전 dry-run과 원본 보존 — 무음 간격 SRT 기준 CUT 2개·ZOOM 2개를 분석하고, 원본 `시퀀스 01`을 보존한 복제 시퀀스에 `SF CUT 01/02`·`SF ZOOM` 마커가 배치됨을 실제 Host에서 확인했습니다.
- [ ] 실패 복구 상태와 민감정보 제거 진단 로그

## 4. H — Windows/macOS 개발 로드

각 OS에서 별도로 확인합니다.

- [ ] `npm run build` 후 UXP Developer Tool에서 `dist/manifest.json`을 Add/Load/Reload할 수 있습니다.
- [ ] Premiere의 UXP 플러그인 메뉴에서 ShortFlow Studio를 열 수 있습니다.
- [ ] 최소 320×480, 권장 dock/floating, 큰 패널에서 UI가 겹치거나 잘리지 않습니다.
- [ ] 키보드 포커스, 탭 전환, disabled/busy/toast와 스크린리더 label이 동작합니다.
- [ ] 프로젝트 없음, 활성 시퀀스 없음, 저장되지 않은 프로젝트에서 안전하게 안내합니다.
- [ ] 패널 Reload/닫기/다시 열기 후 listener 중복이나 메모리 누수가 보이지 않습니다.
- [ ] Windows 한글/공백/긴 경로와 macOS Unicode 경로를 처리합니다.
- [ ] 권한 선택 취소와 OS 권한 철회 후 프로젝트가 손상되지 않습니다.

## 5. H — Premiere 핵심·비파괴 편집

- [x] 프로젝트명/시퀀스명/프레임/길이의 기본 Host 값을 QC에서 읽었습니다. 선택 범위는 별도 검증이 필요합니다.
- [x] QC가 실제 Host에서 잘못된 프레임 규격, 길이, 비디오/오디오 트랙 수를 구분합니다. 현재 세션에서 `1920×1080` 시퀀스가 `1080×1920` 요구사항 불일치로 표시되고, 길이 `00:06`, 비디오/오디오 4트랙이 감지됨을 확인했습니다. 오프라인 미디어 구분은 추가 Host fixture에서 별도 확인합니다.
- [ ] YouTube Shorts/Reels/TikTok과 사용자 지정 규격을 확인했습니다.
- [ ] 전체/인·아웃/선택/재생헤드 범위가 실제 클립 경계와 일치합니다.
- [ ] `fill`/`fit`/원본 유지 및 중앙 정렬을 서로 다른 소스 종횡비로 확인했습니다.
- [ ] 새 시퀀스만 변경되고 원본 시퀀스/클립/트랙/키프레임은 그대로입니다.
- [ ] 동일 이름 충돌과 부분 실패 시 원본이 보존되고 복구 안내가 표시됩니다.
- [ ] 훅/CTA와 ShortFlow 마커가 경계 안에 생성되고 기존 사용자 마커를 손상시키지 않습니다.
- [ ] 마커 구간 일괄 생성의 부분 성공/실패가 개별 기록됩니다.

## 6. H — 자산·레퍼런스·썸네일

- [x] 자산 루트 선택 시 Music/SFX/References/Images/References/Videos/Thumbnails/Exports 구조를 준비합니다.
- [ ] 앱 재시작 후 persistent token을 복구하며 만료 시 재선택을 요구합니다.
- [ ] 깊이 5/최대 5,000 항목, 검색/종류/정렬과 중복 경로 제거가 UI와 일치합니다.
- [ ] 시스템 폴더 열기는 `shell.openPath` 지원 시만 동작하고 미지원 시 친절히 안내합니다.
- [ ] 레퍼런스 이미지/영상 추가, 정렬, 메모, 최대 100개와 삭제를 확인했습니다.
- [ ] 후순위 회귀 참고: AI 이미지 선택은 최대 4개/각 10MB를 지키고 지원하지 않는 형식을 거부합니다. 내부 베타 필수 차단 조건은 아니며, 외부에서 만든 이미지/영상 파일의 레퍼런스 관리와 권리 기록까지만 필수입니다.
- [ ] 7단계 에셋 권리 관리 요구사항으로 음악·이미지·AI 에셋의 출처, 라이선스, 상업 사용 가능 여부, 만료일, 출처 표기 항목을 기록할 수 있어야 합니다.
- [ ] 권리 정보가 없거나 만료된 에셋은 내보내기 전 경고와 리포트 대상으로 표시되어야 합니다.
- [ ] 썸네일 1~4개 레이어, 6개 레이아웃, 조정/그림자/광선/드래그 순서가 preview와 PNG에 일치합니다.
- [ ] Canvas `convertToBlob`/`toBlob` 지원 조합과 UXP 실제 PNG 저장을 확인했습니다. 2026-07-12 Premiere Pro 26.3 smoke에서는 2D context의 이미지/텍스트/export 기능이 부족해 fallback 필요로 판정했습니다.

## 7. H — OpenAI key·이미지·개인정보

- [ ] API key 저장 후 입력 필드가 지워지고 재시작 후 `secureStorage`에서만 복구됩니다.
- [ ] 설정/localStorage/로그/진단/CCX에 API key 또는 Authorization이 평문으로 남지 않습니다.
- [ ] 잘못된 key/401, 429, 5xx, timeout, 오프라인에서 key가 포함되지 않은 오류가 표시됩니다.
- [ ] 신규·저장된 레거시·변조된 endpoint/provider 값이 모두 `https://api.openai.com/v1`로 정규화됩니다.
- [ ] 패널과 manifest에 custom endpoint/provider 우회 경로가 없고 실제 outbound 대상이 OpenAI 공식 origin뿐임을 확인했습니다.
- [ ] 전송 전 이미지/음성/대본/prompt에 필요한 권리와 개인정보 동의를 확인합니다.
- [ ] 패널의 AI 전송 동의 체크박스가 꺼져 있으면 이미지/TTS/STT/자막 AI 요청이 실행되지 않습니다.
- [ ] OpenAI 조직의 데이터 공유/보존/지역 설정을 배포 담당자가 확인했습니다.
- [ ] key 삭제가 실제 secureStorage 항목을 제거합니다.

## 8. H — TTS/STT·자막

- [ ] `speech-evidence/`에 TTS/STT smoke 검증 증거가 있으며 API key, Authorization header, 원본 오디오 bytes가 포함되지 않습니다.
- [ ] TTS 4,096자 경계, 0.25~4배, 모델별 voice와 WAV/MP3/AAC/FLAC을 실제 호출로 확인했습니다.
- [ ] TTS 결과를 선택 폴더에 충돌 없는 이름으로 저장하고 지정 Premiere 오디오 트랙에 삽입합니다. 현재 Host에서는 TTS 카드, 저장 폴더, 자동 삽입 옵션, 오디오 트랙 입력, 생성 버튼 접근성까지 확인했습니다.
- [ ] 영상/서비스의 최종 사용자에게 “AI 생성 음성, 실제 사람 음성 아님” 고지가 명확히 표시됩니다.
- [ ] STT MP3/MP4/MPEG/MPGA/M4A/WAV/WebM과 정확히 25MB/초과 파일을 확인했습니다.
- [ ] diarize 결과의 화자·시간 구간·SRT가 실제 음성과 맞습니다.
- [ ] 일반 transcribe/mini/Whisper 응답과 text/SRT/both 저장을 확인했습니다.
- [ ] 취소/권한 만료/파일 충돌/지원하지 않는 형식을 안전하게 처리합니다.
- [ ] 패널에 연결된 자막 편집기의 SRT import, 단어 chip 표시를 host에서 확인했습니다. export, 숨김/합치기, 큐 분할/병합, undo/redo와 autosave는 추가 Host 확인이 필요합니다.
- [ ] 자막 AI provider를 연결한다면 응답 schema/크기 검증과 사용자 승인 후 적용을 확인합니다.

## 9. H — 자동 편집·Safe Zone·브랜드

- [x] STT가 없고 SRT/자막 문서도 없을 때 자동 컷을 실행하지 않고 안내합니다.
- [x] 실제 Host 자동 편집 탭에서 STT/SRT transcript가 없을 때 실행 버튼이 비활성 상태로 유지되고 프로젝트 mutation 없이 안내가 표시됩니다.
- [x] SRT로 가져온 자막 문서를 자동 컷 transcript fallback으로 사용합니다. `subtitleDocumentToAutomationTranscript` 테스트와 실제 Host 디버그 상태에서 2개 타임코드 표시를 확인했습니다.
- [ ] 무음 기준/padding/선행·후행 trim과 제거 예상 길이가 실제 결과와 일치합니다.
- [ ] 적용 전 marker preview와 원본 복제 정책을 확인할 수 있습니다.
- [ ] 펀치 키프레임은 겹치지 않고 기존 효과를 예상 밖으로 덮어쓰지 않습니다.
- [ ] Safe Zone은 “공식 고정 규격”이 아닌 revision이 있는 보수적 가이드로 표시됩니다.
- [x] Safe Zone BMP overlay 실제 import/insert를 Host에서 확인했습니다. Premiere 프로젝트 패널에 ShortFlow 가이드 에셋이 추가되고 프로그램 모니터에 Safe Zone guide가 표시됐습니다. export 전 삭제 경고는 최종 export gate에서 다시 확인합니다.
- [ ] 최종 QC JSON/Markdown의 Safe Zone 판정 메시지에도 같은 revision이 남습니다.
- [ ] 플랫폼/사용자 margin 변경과 자동 정렬 preview가 실제 9:16 결과와 일치합니다.
- [ ] 브랜드 키트 생성/복제/삭제/JSON import/export와 20개 제한이 동작합니다.
- [ ] 로고/MOGRT token 만료, 누락 폰트와 잘못된 색/파일을 안내합니다.
- [ ] 브랜드 기본값이 자막/썸네일/TTS/MOGRT에 사용자 확인 후 적용됩니다.

## 10. H — AI 작업 큐

- [ ] 동시 실행 1~3, pause/resume, cancel과 progress가 UI 상태와 일치합니다.
- [ ] 동일 내용/options hash가 중복 실행되지 않습니다.
- [ ] 429/5xx만 bounded retry되고 영구 오류는 반복하지 않습니다.
- [ ] 일일 요청/비용은 USD/KRW가 아닌 provider unit임을 UI에서 명확히 합니다.
- [ ] 작업별 예상 단위가 승인 임계값을 넘으면 실행 전 승인을 기다립니다.
- [ ] 앱 재시작 시 running은 queued로 복구되지만 파일 권한/실행 handler가 없으면 자동 재개하지 않습니다.
- [ ] localStorage에는 바이너리가 아닌 metadata/file token만 저장됩니다.

## 11. H — 복구·최종 QC·진단 통합

복구, 최종 QC와 진단 UI는 패널 작업 흐름에 연결됐습니다. 실제 Host에서 확인한 범위와 아직 남은 범위를 항목별로 구분합니다.

- [x] 자동 컷 mutation에서 clone-before-mutation 정책, 원본 보존과 실제 Premiere 복제 시퀀스를 확인했습니다.
- [ ] begin/commit 저널 2건의 재시작 후 지속성은 확인했습니다. fail/rollback과 외부 파일/인코더 보상 callback은 별도 검증이 필요합니다.
- [ ] 실행 중 종료 후 `interrupted` 안내와 수동 복원 경로를 host에서 확인합니다.
- [x] 최종 QC를 실제 Host에서 실행했습니다. 현재 fixture 결과는 `PASS 16 · WARNING 4 · ERROR 4`이고 frame size·aspect ratio·guide overlay·output path가 차단 오류입니다.
- [ ] hard-block waiver 불가와 일반 waiver 사유/시간/코드 기록을 UI에서 확인합니다.
- [x] 실제 Host 진단 JSON에서 현재 fixture 기준 API key·Bearer·사용자 절대경로·이메일·미디어 파일명·전사/프롬프트/콘텐츠 필드 패턴이 없음을 확인했습니다. 합성 민감값 능동 redaction은 별도 검증이 필요합니다.
- [x] 진단 capability probe를 실제 UXP API에 연결해 Premiere 26.3.0, UXP `uxp-9.3.0-local`, `compatible: true`를 확인했습니다.
- [ ] telemetry는 기본 꺼짐이며 명시적 opt-in/철회/삭제 UI와 개인정보 처리방침이 있을 때만 provider를 연결합니다.

## 12. H — MOGRT·Media Encoder·최종 출력

- [ ] `.mogrt` 선택 취소/권한 만료/잘못된 파일을 처리합니다.
- [ ] 재생헤드와 지정 트랙에 삽입되고 기존 클립 충돌을 안내합니다.
- [ ] `.epr` 선택과 전체/인·아웃 범위가 Media Encoder job과 일치합니다.
- [ ] queue/immediate 모드, Media Encoder 미설치와 인코딩 실패를 처리합니다.
- [ ] 출력 파일 충돌 시 예고 없이 덮어쓰지 않습니다.
- [ ] 현재 프레임 cover의 프레임/해상도/경로가 정확합니다.
- [ ] YouTube Shorts/Reels/TikTok 실제 업로드 전 해상도·FPS·오디오·자막·Safe Zone을 검토합니다.
- [ ] 12단계 배포 전 검증에서 음악·이미지·AI 에셋 권리 리포트가 최종 QC/배포 자료에 포함됩니다.
- [ ] 상업 사용 불가, 출처 표기 누락, 라이선스 만료 에셋은 외부 배포 전 차단 또는 승인 예외 기록 대상으로 분류됩니다.

## 13. CCX·Windows/macOS·Adobe 배포

- [ ] 최종 체크포인트에서 `npm run package:ccx:force`가 성공합니다.
- [ ] 최종 체크포인트에서 `npm run verify:release`가 성공하고 CCX 내부 루트 구조·금지 경로·중복 엔트리·traversal 검사를 통과합니다.
- [ ] 기존 `release/`에 남은 오래된 CCX가 있으면 최종 후보 재생성 전 `verify:release`가 실패할 수 있음을 확인했습니다. 최종 체크포인트에서는 새 CCX/SHA를 생성한 뒤 검증합니다.
- [ ] 최종 체크포인트 CCX 루트에 manifest/index/styles/script/icons가 있고 상위 `dist/`가 없습니다.
- [ ] 최종 체크포인트 CCX에 `src/`, `tests/`, `node_modules/`, `.git/`, `.env*`, key/credentials/source map 파일이 없습니다.
- [ ] 최종 체크포인트 CCX 내부 경로가 절대경로, 드라이브 경로, `..` traversal, 중복 엔트리, 명시적 디렉터리 엔트리를 포함하지 않습니다.
- [x] 내부 베타 dist source map은 비포함으로 결정했고 `verify:dist`가 `.map` 파일과 `sourceMappingURL`을 차단합니다.
- [ ] 최종 체크포인트에서 `.sha256.txt`가 실제 CCX와 일치하는지 다시 기록합니다.
- [ ] 최종 체크포인트에서 검증 표시된 내부 베타 증거 파일을 새로 생성합니다.
- [x] 같은 버전의 다른 기존 CCX를 기본 명령이 덮어쓰지 않습니다. `scripts/package-ccx.mjs`는 내용이 다르면 `--force` 없이는 중단합니다.
- [ ] `package:ccx:force` 사용 사유와 원본 보관 위치를 기록했습니다.
- [ ] 개발 ID를 Adobe 정식 plugin ID로 교체하고 버전/권한/privacy/support 정보를 검토했습니다.
- [ ] Adobe가 요구하는 서명/notarization/조직 배포 또는 Marketplace 심사를 완료했습니다.
- [ ] Windows 신규 설치/업데이트/제거를 승인된 설치 흐름에서 확인했습니다.
- [ ] macOS Intel/Apple Silicon 신규 설치/업데이트/제거를 승인된 설치 흐름에서 확인했습니다.
- [ ] SmartScreen/Gatekeeper/quarantine을 임의로 우회하지 않았습니다.
- [ ] 설치 후 Premiere 재시작과 핵심 회귀 테스트를 완료했습니다.

## 14. 최종 승인

- [ ] [요구사항 추적표](REQUIREMENTS_MATRIX.md)의 모든 배포 범위 행에 A/M/H 근거가 있습니다.
- [ ] 엔진 준비 상태 기능은 패널에 연결했거나 배포 범위에서 명시적으로 제외했습니다.
- [ ] 알려진 제약, API 비용, AI 음성 고지와 개인정보 처리 내용을 릴리스 노트에 반영했습니다.
- [ ] 미해결 예외마다 위험, 완화책, 담당자, 승인자와 만료일을 기록했습니다.
- [ ] CCX SHA-256, 서명/심사 결과와 최종 승인자를 보관했습니다.

## 15. 13단계 이후 후속 기능 기록

아래 항목은 현재 릴리스 범위가 아닙니다. 13단계 이후에 별도 설계·구현·검증 계획을 세웁니다.

- [ ] 14. 스마트 리프레임·피사체 추적
- [ ] 15. 다국어 패키지 생성: 번역 자막, 언어별 TTS 더빙, 제목·설명·썸네일
- [ ] 16. 썸네일 3종 변형 생성·내보내기. Shorts A/B 자동 판정은 약속하지 않음
- [ ] 17. 타임코드 검토·수정 요청·버전 스냅샷
- [ ] 18. 플랫폼별 업로드 패키지 생성: 영상, 썸네일, SRT, 제목·설명·해시태그, 에셋 목록
