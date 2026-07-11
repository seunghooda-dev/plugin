# ShortFlow Studio 릴리스 QA 체크리스트

이 문서는 자동 검사, 정적/mock 검사와 실제 Premiere 호스트 검사를 분리합니다. 릴리스마다 사본을 만들어 담당자·날짜·OS·Premiere/Media Encoder/UXP Developer Tool 버전·프로젝트·CCX SHA-256을 기록해 주세요.

## 0. 증거 등급

- **A — 자동 게이트**: 명령 출력으로 재현 가능한 TypeScript/ESLint/Node/Vite/패키지 검사
- **M — mock/순수 테스트**: Premiere/UXP 어댑터를 가짜 객체로 검증한 결과
- **H — host 테스트**: 실제 Premiere Pro/UXP/Media Encoder/파일 시스템에서 사람이 확인한 결과

2026-07-11 현재 A/M 증거로 `npm test` 821/821 통과를 확인했습니다. 이 저장소 환경에는 Premiere가 없어 H 항목은 수행하지 않았습니다.

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

- [x] `npm test`가 821/821을 통과했습니다(2026-07-11 현재 작업 트리).
- [ ] 새 릴리스 소스에서 Node.js 20.19+ `npm install`이 성공합니다.
- [ ] `npm run typecheck`가 성공합니다.
- [ ] `npm run lint`가 성공합니다.
- [ ] `npm test`가 성공하며 테스트 수 감소 사유를 검토했습니다.
- [ ] `npm run build`가 성공합니다.
- [ ] `npm run check`가 한 번에 성공합니다.
- [ ] `dist/manifest.json`은 manifest v5, `premierepro`, 최소 25.6.0입니다.
- [ ] package/manifest 버전이 일치합니다.
- [ ] `dist`에 심볼릭 링크, `.env`, 인증서/private key, credentials/secret 파일과 250MB 초과 단일 파일이 없습니다.
- [ ] manifest network domain은 wildcard·인증정보·query 없는 HTTPS origin입니다.
- [ ] HTML이 로컬 `styles.css`/`index.js`를 참조하고 아이콘/로컬 source map이 존재합니다.

## 3. M — mock/순수 모듈 범위

- [x] core/설정/파일명/시간 범위와 기본 QC 테스트가 있습니다.
- [x] Premiere 공개 API 어댑터의 정상·누락 API·경로·트랙 경계 테스트가 있습니다.
- [x] 자산/레퍼런스 persistent token, 취소·만료·중복·입력 상한 테스트가 있습니다.
- [x] GPT Image 2 multipart, HTTPS/SSRF, timeout/retry, base64, key redaction 테스트가 있습니다.
- [x] TTS/STT 요청 형식, 4,096자/25MB, voice/model/format과 SRT 테스트가 있습니다.
- [x] 자막 편집/undo/redo/autosave/DOM 상한 테스트가 있습니다.
- [x] 썸네일 reducer/layout/Canvas/PNG fallback 테스트가 있습니다.
- [x] 자동 편집 계획과 Safe Zone 계산 테스트가 있습니다.
- [x] 브랜드 키트 validation/import/token/max 20 테스트가 있습니다.
- [x] AI queue retry/cancel/dedupe/cache/budget/restore 테스트가 있습니다.
- [x] 복구 저널 상태 전이/rollback/interrupted/직렬화 테스트가 있습니다.
- [x] 최종 QC hard-block/waiver/JSON/Markdown/입력 상한 테스트가 있습니다.
- [x] 진단 redaction/API guard/telemetry opt-in·allowlist·retry 테스트가 있습니다.

M 통과만으로 실제 UXP method 이름, Premiere 프로젝트 mutation, 코덱, Canvas 구현과 OS 권한을 보증하지 않습니다.

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

- [ ] 프로젝트명/시퀀스명/프레임/길이/선택 범위가 실제 값과 일치합니다.
- [ ] QC가 1080×1920, 잘못된 규격, 길이, 트랙, 오프라인 미디어를 구분합니다.
- [ ] YouTube Shorts/Reels/TikTok과 사용자 지정 규격을 확인했습니다.
- [ ] 전체/인·아웃/선택/재생헤드 범위가 실제 클립 경계와 일치합니다.
- [ ] `fill`/`fit`/원본 유지 및 중앙 정렬을 서로 다른 소스 종횡비로 확인했습니다.
- [ ] 새 시퀀스만 변경되고 원본 시퀀스/클립/트랙/키프레임은 그대로입니다.
- [ ] 동일 이름 충돌과 부분 실패 시 원본이 보존되고 복구 안내가 표시됩니다.
- [ ] 훅/CTA와 ShortFlow 마커가 경계 안에 생성되고 기존 사용자 마커를 손상시키지 않습니다.
- [ ] 마커 구간 일괄 생성의 부분 성공/실패가 개별 기록됩니다.

## 6. H — 자산·레퍼런스·썸네일

- [ ] 자산 루트 선택 시 Music/SFX/References/Images/References/Videos/Thumbnails/Exports 구조를 준비합니다.
- [ ] 앱 재시작 후 persistent token을 복구하며 만료 시 재선택을 요구합니다.
- [ ] 깊이 5/최대 5,000 항목, 검색/종류/정렬과 중복 경로 제거가 UI와 일치합니다.
- [ ] 시스템 폴더 열기는 `shell.openPath` 지원 시만 동작하고 미지원 시 친절히 안내합니다.
- [ ] 레퍼런스 이미지/영상 추가, 정렬, 메모, 최대 100개와 삭제를 확인했습니다.
- [ ] AI 이미지 선택은 최대 4개/각 10MB를 지키고 지원하지 않는 형식을 거부합니다.
- [ ] 썸네일 1~4개 레이어, 6개 레이아웃, 조정/그림자/광선/드래그 순서가 preview와 PNG에 일치합니다.
- [ ] Canvas `convertToBlob`/`toBlob` 지원 조합과 UXP 실제 PNG 저장을 확인했습니다.

## 7. H — OpenAI key·이미지·개인정보

- [ ] API key 저장 후 입력 필드가 지워지고 재시작 후 `secureStorage`에서만 복구됩니다.
- [ ] 설정/localStorage/로그/진단/CCX에 API key 또는 Authorization이 평문으로 남지 않습니다.
- [ ] 잘못된 key/401, 429, 5xx, timeout, 오프라인에서 key가 포함되지 않은 오류가 표시됩니다.
- [ ] 신규·저장된 레거시·변조된 endpoint/provider 값이 모두 `https://api.openai.com/v1`로 정규화됩니다.
- [ ] 패널과 manifest에 custom endpoint/provider 우회 경로가 없고 실제 outbound 대상이 OpenAI 공식 origin뿐임을 확인했습니다.
- [ ] 전송 전 이미지/음성/대본/prompt에 필요한 권리와 개인정보 동의를 확인합니다.
- [ ] OpenAI 조직의 데이터 공유/보존/지역 설정을 배포 담당자가 확인했습니다.
- [ ] key 삭제가 실제 secureStorage 항목을 제거합니다.

## 8. H — TTS/STT·자막

- [ ] TTS 4,096자 경계, 0.25~4배, 모델별 voice와 WAV/MP3/AAC/FLAC을 실제 호출로 확인했습니다.
- [ ] TTS 결과를 선택 폴더에 충돌 없는 이름으로 저장하고 지정 Premiere 오디오 트랙에 삽입합니다.
- [ ] 영상/서비스의 최종 사용자에게 “AI 생성 음성, 실제 사람 음성 아님” 고지가 명확히 표시됩니다.
- [ ] STT MP3/MP4/MPEG/MPGA/M4A/WAV/WebM과 정확히 25MB/초과 파일을 확인했습니다.
- [ ] diarize 결과의 화자·시간 구간·SRT가 실제 음성과 맞습니다.
- [ ] 일반 transcribe/mini/Whisper 응답과 text/SRT/both 저장을 확인했습니다.
- [ ] 취소/권한 만료/파일 충돌/지원하지 않는 형식을 안전하게 처리합니다.
- [ ] 패널에 연결된 자막 편집기의 SRT import/export, 단어 편집, 숨김/합치기, 큐 분할/병합, undo/redo와 autosave를 host에서 확인합니다.
- [ ] 자막 AI provider를 연결한다면 응답 schema/크기 검증과 사용자 승인 후 적용을 확인합니다.

## 9. H — 자동 편집·Safe Zone·브랜드

- [ ] STT가 없을 때 자동 컷을 실행하지 않고 안내합니다.
- [ ] 무음 기준/padding/선행·후행 trim과 제거 예상 길이가 실제 결과와 일치합니다.
- [ ] 적용 전 marker preview와 원본 복제 정책을 확인할 수 있습니다.
- [ ] 펀치 키프레임은 겹치지 않고 기존 효과를 예상 밖으로 덮어쓰지 않습니다.
- [ ] Safe Zone은 “공식 고정 규격”이 아닌 revision이 있는 보수적 가이드로 표시됩니다.
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

복구, 최종 QC와 진단 UI는 패널 작업 흐름에 연결됐습니다. 아래 항목은 모두 실제 호스트 증거가 필요합니다.

- [ ] mutation마다 clone-before-mutation 정책을 실제 Premiere clone ID로 검증합니다.
- [ ] begin/commit/fail/rollback journal과 외부 파일/인코더 보상 callback을 연결합니다.
- [ ] 실행 중 종료 후 `interrupted` 안내와 수동 복원 경로를 host에서 확인합니다.
- [ ] 최종 QC snapshot에 자막 rect/time/CPS, audio peak/silence/LUFS, 누락 media/font/asset/guide, output path를 실제 수집합니다.
- [ ] hard-block waiver 불가와 일반 waiver 사유/시간/코드 기록을 UI에서 확인합니다.
- [ ] JSON/Markdown gate report에 민감 경로/key가 없는지 확인합니다.
- [ ] 진단 capability probe를 실제 UXP API에 연결하고 익명 bundle을 검토합니다.
- [ ] telemetry는 기본 꺼짐이며 명시적 opt-in/철회/삭제 UI와 개인정보 처리방침이 있을 때만 provider를 연결합니다.

## 12. H — MOGRT·Media Encoder·최종 출력

- [ ] `.mogrt` 선택 취소/권한 만료/잘못된 파일을 처리합니다.
- [ ] 재생헤드와 지정 트랙에 삽입되고 기존 클립 충돌을 안내합니다.
- [ ] `.epr` 선택과 전체/인·아웃 범위가 Media Encoder job과 일치합니다.
- [ ] queue/immediate 모드, Media Encoder 미설치와 인코딩 실패를 처리합니다.
- [ ] 출력 파일 충돌 시 예고 없이 덮어쓰지 않습니다.
- [ ] 현재 프레임 cover의 프레임/해상도/경로가 정확합니다.
- [ ] YouTube Shorts/Reels/TikTok 실제 업로드 전 해상도·FPS·오디오·자막·Safe Zone을 검토합니다.

## 13. CCX·Windows/macOS·Adobe 배포

- [ ] `npm run package:ccx`가 성공합니다.
- [ ] CCX 루트에 manifest/index/styles/script/icons가 있고 상위 `dist/`가 없습니다.
- [ ] CCX에 `src/`, `tests/`, `node_modules/`, `.git/`, `.env*`, key/credentials 파일이 없습니다.
- [ ] 현재 포함되는 `index.js.map`을 공개 배포에 유지할지 결정하고, 유지 시 `sourcesContent`에 비밀·내부 경로·비공개 정보가 없는지 검토했습니다.
- [ ] `.sha256.txt`가 실제 CCX와 일치합니다.
- [ ] 같은 버전의 다른 기존 CCX를 기본 명령이 덮어쓰지 않습니다.
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
