# ShortFlow Studio Premiere 실제 Host Smoke Runbook

기준일: 2026-07-11  
실행 시점: Premiere Pro와 UXP Developer Tool 설치 후

Mock Host와 자동 테스트는 실제 Premiere 프로젝트 mutation, UXP 권한, 트랙 상태와 파일 경로 동작을 보증하지 않습니다. 이 문서는 설치 후 실제 Host 근거를 남기는 별도 게이트입니다.

## 0. Smoke 시작 전 공통 준비물

실제 Host smoke는 항상 최신 로컬 후보와 테스트 전용 프로젝트에서만 실행합니다.

1. 로컬 후보 검증
   - `npm run check`가 통과한 작업트리에서 시작합니다.
   - Host smoke 직전 `npm run build`로 `dist/`를 최신화합니다.
   - UXP Developer Tool에서 이 저장소의 `plugin/dist/manifest.json`을 대상으로 `Reload` 또는 `Load` 성공 toast를 확인합니다.
   - 기존 설치/캐시 패널과 최신 `dist` 패널이 다를 수 있으므로, smoke 시작 시점의 패널이 최신 `dist`인지 먼저 기록합니다.
2. 테스트 프로젝트
   - 원본 프로젝트가 아닌 테스트 전용 Premiere 프로젝트를 사용합니다.
   - 1080×1920, 30fps, 5초 이상 테스트 시퀀스를 준비합니다.
   - V1/A1에 짧은 테스트 MP4를 삽입하고, 잠금 없는 추가 비디오·오디오 트랙을 확보합니다.
3. 테스트 fixture
   - `host-smoke-assets/shortflow_host_smoke_9x16.mp4`
   - `host-smoke-assets/shortflow_host_smoke.srt`
   - `host-smoke-assets/Music/test-music.mp3`
   - `host-smoke-assets/SFX/test-click.wav`
   - API key 없이 검증할 때는 사전 생성된 WAV/MP3로 import·insert 경로만 확인합니다.
4. 기록 방식
   - 각 항목은 사용자 클릭 경로, 기대 화면, 실제 화면, 로그 문구, 필요한 수정 파일을 기록합니다.
   - API key가 필요한 live TTS/STT smoke와 로컬 파일 import·insert smoke를 분리합니다.
   - 실패가 재현되면 같은 mutation을 반복 적용하지 말고 프로젝트 사본 또는 복제 시퀀스에서 재시도합니다.

## 1. 사전 조건

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`가 성공한 로컬 후보를 사용합니다.
- UXP Developer Tool에는 `dist/manifest.json`을 등록합니다.
- 테스트 전용 Premiere 프로젝트와 복사 가능한 테스트 미디어를 사용합니다.
- 원본 프로젝트가 아닌 복제본에서 시작합니다.
- Host 변경 전 dry-run 또는 preview를 먼저 확인합니다.
- 실패 시 오류 문구, 진단 로그, 프로젝트/시퀀스 상태를 기록하고 같은 작업을 반복 적용하지 않습니다.

## 2. 환경 기록

- Windows/macOS 버전과 CPU 아키텍처
- Premiere Pro 버전
- UXP Developer Tool 버전
- 테스트 소스 식별자 또는 commit SHA
- 테스트 프로젝트·시퀀스·미디어 세트
- 실행 담당자와 시각

## 3. 필수 Smoke Test

아래 순서와 번호를 유지합니다.

1. **UXP 패널 로드**
   - Add, Load, Reload, 패널 닫기/재열기를 확인합니다.
   - listener·timer 중복, 흰 화면, 콘솔 예외가 없어야 합니다.
2. **Mock Host와 실제 Host 전환**
   - production 진입점이 실제 adapter를 사용하고 테스트 adapter가 번들 실행 경로에 남지 않는지 확인합니다.
   - 전환 실패가 프로젝트 mutation으로 이어지지 않아야 합니다.
   - QC 실행 후 ShortFlow의 프로젝트명, 시퀀스명, 프레임 크기, 트랙 수가 Premiere 화면과 일치해야 합니다.
3. **현재 프로젝트·시퀀스 감지**
   - 프로젝트 없음, 시퀀스 없음, 활성 시퀀스 있음 상태를 구분합니다.
4. **플레이헤드 위치 읽기**
   - 시작, 중간, 끝 근처에서 Premiere 표시와 패널 값이 일치하는지 확인합니다.
5. **In/Out 범위 읽기**
   - 미설정, 정상 범위, 잘못된/빈 범위를 안전하게 구분합니다.
6. **선택 클립 감지**
   - 비선택, 단일/복수 선택, 잠긴 트랙과 영상·오디오 선택을 확인합니다.
7. **SRT/캡션 삽입**
   - SRT 파일 가져오기와 실제 지원되는 캡션 삽입 경계를 구분해 기록합니다.
   - 지원하지 않는 공개 API 동작을 성공으로 표시하지 않습니다.
   - 통과 기준은 SRT 저장과 프로젝트 import 성공입니다. 캡션 트랙 자동 생성·타임라인 배치는 공개 API 미지원이면 제한사항으로 기록합니다.
8. **TTS 오디오 가져오기**
   - 선택 출력 폴더 저장, 충돌 없는 이름, 프로젝트 import와 지정 오디오 트랙 삽입을 확인합니다.
   - OpenAI live smoke는 별도 승인/API key가 있을 때만 실행합니다. 승인 없이 진행할 때는 로컬 WAV/MP3 fixture로 import·insert 경로만 확인합니다.
9. **음악·효과음 타임라인 삽입**
   - 기존 import 재사용, 재생헤드 위치, 대상 트랙, 잠금/충돌 실패를 확인합니다.
   - 자산 루트 선택, 동기화, 카테고리 필터, 미리듣기, 더블클릭 또는 버튼 삽입, 잠긴 트랙 실패 메시지를 각각 기록합니다.
10. **썸네일 내보내기 파일 경로**
    - Windows 한글·공백 경로, 확장자, 파일명 충돌과 PNG/JPG 출력을 확인합니다.
11. **자동 컷·펀치인 dry-run**
    - 적용 전 예상 컷/유지/펀치인 범위와 marker 수를 검토합니다.
    - 원본 시퀀스는 보존하고 복제 시퀀스에서만 적용합니다.
    - 권장 순서는 SRT fixture 로드, dry-run 분석, 추천 마커 추가, 복제 시퀀스 적용, 원본 보존 확인, 복제 시퀀스의 마커·키프레임 확인입니다.
12. **실패 복구·진단 로그**
    - Host API 실패, 권한 거부, 잘못된 트랙과 부분 실패를 재현합니다.
    - 복구 상태와 사용자 실행 진단 로그에 API key, token, Authorization과 불필요한 전체 로컬 경로가 없어야 합니다.

## 4. 실제 삽입 공통 확인

- 현재 프로젝트·시퀀스가 작업 시작 시점과 동일한지 다시 확인합니다.
- 트랙 인덱스는 유효 범위이며 잠긴 트랙을 변경하지 않습니다.
- 동일 파일은 경로 기반으로 식별하고 불필요하게 중복 import하지 않습니다.
- 적용 실패 시 원본 시퀀스와 기존 클립·키프레임이 보존됩니다.
- Mock에서 통과했지만 Host에서 실패한 경우, 실제 API 결과를 근거로 최소 수정하고 Mock 회귀 테스트를 추가합니다.

Safe Zone BMP overlay는 실제 Host에서 통과했습니다.

- `자동 점프컷·펀치인·Safe Zone` 탭에서 Premiere 가이드 오버레이 생성을 실행합니다.
- 프로젝트/bin 또는 타임라인에 `__SHORTFLOW_SAFE_GUIDE_DO_NOT_EXPORT__` 접두 파일/클립이 생기는지 확인했습니다.
- `videoTrackIndex: status.videoTrackCount`가 실제 Host에서 가이드 에셋 import와 프로그램 모니터 표시까지 동작하는지 확인했습니다.
- export 전 삭제 경고가 표시되고, 최종 산출 전 사용자가 가이드 클립을 삭제했는지 확인합니다.

## 5. 즉시 차단 조건

- 원본 시퀀스 또는 사용자 기존 클립이 예고 없이 변경됨
- 패널 load/reload가 Premiere crash 또는 반복 listener를 유발함
- 잠긴 트랙이나 선택하지 않은 시퀀스를 변경함
- 실패 후 복제 시퀀스·임시 파일·복구 저널 상태가 불명확하게 남음
- API key, persistent token 또는 Authorization이 로그·리포트에 노출됨
- 지원하지 않는 공개 UXP 기능을 성공으로 표시함

## 6. 결과 기록

각 번호마다 `통과 / 실패 / 보류`, Premiere 버전, 재현 절차, 기대값, 실제값, 로그 식별자와 필요한 수정 파일을 기록합니다. 12개 항목이 모두 통과하거나 승인된 제한사항으로 문서화되기 전에는 실제 Premiere 내부 베타 통과로 판정하지 않습니다.

## 7. 실제 Smoke 기록 — 2026-07-12 02:51 KST

환경:

- Premiere Pro: 2026, UXP Developer Tools 연결 대상 `premierepro v26.3.0`
- 플러그인 ID: `com.seunghooda.shortflow.studio.direct`
- 로컬 후보: 당시 `npm run check` 통과 상태, 945/945 tests. 이후 13번 기록에서 974/974 후보로 갱신됐고, 현재 최신 요약은 아래 진행 중 메모를 기준으로 합니다.
- Premiere 프로세스: 실행 중, `Responding: True`
- UXP Developer Tools: 실행 중, `Responding: True`

결과:

| 항목 | 상태 | 실제값 |
|---|---|---|
| 1. UXP 패널 로드 | 통과 | UXP Developer Tools에서 `Load` 실행 시 `Plugin Load Successful`, `Loaded` 확인. Premiere 안에 `ShortFlow Studio` 패널 표시 확인. |
| 1-a. Premiere 재실행 직후 자동 로드 | 보류/주의 | 재실행 직후 UXP Developer Tools 상태가 `Not loaded`였고, Premiere 메뉴의 `창 → UXP 플러그인`에는 플러그인 찾아보기/관리만 표시됨. 개발 로드에서는 UDT에서 다시 `Load` 필요. |
| 2. Mock Host와 실제 Host 전환 | 제한 통과 | 패널 표시와 로컬 저장 초기화가 확인됐고, 사용자가 Premiere/플러그인 정상으로 보고 후속 개발 진행을 승인함. 실제 시퀀스 mutation은 별도 테스트 프로젝트에서 재확인 필요. |
| 3. 현재 프로젝트·시퀀스 감지 | 제한 통과 | 테스트 전용 새 프로젝트 `ShortFlow_HostSmoke_20260712` 생성 완료. 빈 프로젝트/시퀀스 없음 상태에서 패널 로드가 유지됨. |
| 4~12. 실제 Host 기능 | 사용자 승인 기준 보류 | 사용자가 Premiere와 플러그인을 정상으로 간주하고 나머지 로컬 개발을 진행하도록 지시함. 실제 미디어 삽입·SRT 삽입·자동 컷 복제 시퀀스 적용은 내부 베타 최종 검증 전에 같은 runbook 순서로 재확인. |

관찰:

- 플러그인 LocalStorage에 `shortflow.settings.v1`와 `shortflow.brand-kits.v1` 기록이 생성되어 패널 JS 초기화와 저장 경로는 동작했습니다.
- 이전 세션에서 최근 프로젝트 `무제`를 열 때 Premiere가 `응답 없음`이 되었고, 재실행 후 “프로젝트가 열려 있을 때 Premiere가 예기치 않게 종료되었습니다” 복구 알림이 표시됐습니다.
- 이번 재실행 후 UDT `Load`로 패널을 다시 띄운 뒤 Premiere는 응답 상태를 유지했습니다.
- `ShortFlow_HostSmoke_20260712` 테스트 프로젝트를 생성했고, 이후 사용자가 “프리미어랑 다 정상적이라고 생각하고 나머지 작업 진행”을 지시했습니다. 따라서 현재 개발 판단에서는 Host 기본 정상으로 취급하되, 배포 승인 전 4~12번 mutation 항목은 다시 실행해야 합니다.

다음 검증:

1. 테스트 전용 새 프로젝트를 생성합니다.
2. 9:16 빈 시퀀스와 짧은 테스트 미디어 1개를 추가합니다.
3. 이 문서 3번의 1~12 항목을 순서대로 실행합니다.
4. 프로젝트 열기/패널 로드 중 응답 없음이 재현되면 UDT APP LOGS와 Premiere `Plugin Loading.log`, `Trace Database.txt`를 함께 기록합니다.

## 8. 실제 Smoke 추가 기록 — 2026-07-12 03:26 KST

환경:

- Premiere Pro: 2026, UXP Developer Tools 연결 대상 `premierepro v26.3.0`
- 플러그인 ID: `com.seunghooda.shortflow.studio.direct`
- 로컬 후보: 최종 체크포인트에서 `npm run beta:evidence:verified`로 CCX/SHA-256과 증거 파일을 갱신
- CCX 후보 SHA-256: 최종 체크포인트에서 새로 생성한 값으로 기록

결과:

| 항목 | 상태 | 실제값 |
|---|---|---|
| 1. UXP 패널 로드 | 통과 | UXP Developer Tools에서 `Load` 실행 후 `Plugin Load Successful`, `Loaded` 상태 확인. |
| 1-b. Premiere 내 패널 객체 | 제한 통과 | Premiere 접근성 트리에서 `dvauxpuiUXPPanel`과 `ShortFlow Studio` 탭 객체가 확인됨. |
| 3. 프로젝트 열기 | 제한 통과 | 최근 프로젝트 `ShortFlow_HostSmoke_20250712`를 열어 Premiere 편집 화면으로 진입함. 활성 시퀀스는 없는 상태로 표시됨. |
| 4~12. 실제 Host 기능 | 보류 | Windows 앱 자동 조작 연결이 Premiere 창 `click`/`activate_window`에서 시간 초과되어 메뉴 조작과 실제 mutation smoke를 이어가지 못함. UXP 로드 자체는 통과했으므로 이후 테스트는 수동 또는 자동 조작 연결 복구 후 재개. |

관찰:

- UDT 기준 플러그인 상태는 `Loaded`이며, APP LOGS가 아닌 UDT LOGS 기준으로 `Validate command successfull in App with ID premierepro v26.3.0`와 `Load command successfull in App with ID premierepro v26.3.0`가 기록됐습니다.
- Premiere 편집 화면 진입 후 제목 표시줄은 열린 로컬 프로젝트 경로를 표시했습니다.
- 실제 시퀀스/트랙/미디어 삽입 검증은 활성 시퀀스와 테스트 미디어가 준비된 상태에서 다시 실행해야 합니다.

## 9. 실제 Smoke 추가 기록 — 2026-07-12 10:53 KST

환경:

- Premiere Pro: 2026, UXP Developer Tools 연결 대상 `premierepro v26.3.0`
- UXP Developer Tools 상태: `Debugging`, `Reload` 성공 toast 확인
- 플러그인 ID: `com.seunghooda.shortflow.studio.direct`
- 로컬 후보: `npm run typecheck`, `npm run lint`, `npm run build` 통과 후 `dist` reload
- 테스트 상태: 빈 Premiere 프로젝트, 활성 시퀀스 없음

결과:

| 항목 | 상태 | 실제값 |
|---|---|---|
| 1. UXP 패널 로드 | 통과 | `창 → UXP 플러그인 → ShortFlow Studio`에서 플로팅 패널 표시 확인. |
| 1-c. 패널 bootstrap | 통과 | Premiere 26.3에서 `entrypoints.setup().show()`만으로는 핵심 이벤트 바인딩이 실행되지 않아, 스크립트 로드 시 idempotent `startPanel()`을 추가했습니다. Reload 후 `ShortFlow Studio가 준비되었습니다.` 로그 확인. |
| 3. 프로젝트·시퀀스 없음 상태 | 통과 | 빈 프로젝트에서 `Premiere 연결 필요`, `활성 시퀀스 없음`을 표시하고 패널 초기화는 유지됨. |
| 3-a. QC 버튼 | 제한 통과 | CDP 직접 click 기준 `QC 실패: 활성 시퀀스가 없습니다. 타임라인을 먼저 열어 주세요.`가 로그에 기록됨. 프로젝트 mutation 없음. |
| 9/13. TTS·STT/Safe Zone 초기화 | 제한 통과 | `TextEncoder/TextDecoder` 폴백, TTS null value guard, Safe Zone Canvas 부분 API guard 적용 후 초기화 오류 제거. |
| 10. 썸네일 Canvas | 실패/수정 필요 | Premiere UXP 26.3 Canvas 2D context에서 `drawImage`, `fillText`, `toBlob`, `toDataURL`이 제공되지 않음. 현재는 패널 전체 초기화를 막지 않고 안내 로그로 낮춤. 내부 베타 썸네일 PNG/JPG export는 SVG/HTML fallback 또는 별도 렌더 경로가 필요. |

관찰:

- UXP Debug CDP에서 `document.body.innerText`, 상태 필드, activity log를 직접 확인했습니다.
- UXP `require("uxp")` 표면에는 `storage`만 확인됐고 `imaging` API는 노출되지 않았습니다.
- 빈 프로젝트 기준 최종 패널 로그는 `INFO ShortFlow Studio가 준비되었습니다.`와 썸네일 Canvas 제한 안내만 남았습니다.
- 활성 시퀀스가 없을 때 자막 컨트롤러는 `session` fallback project key로 초기화되도록 수정했습니다.

다음 검증:

1. 실제 9:16 테스트 시퀀스와 짧은 미디어를 만든 뒤 3~9번 Host smoke를 이어서 실행합니다.
2. 썸네일은 실제 UXP Canvas 대신 SVG 기반 미리보기/내보내기 또는 다른 로컬 렌더 경로를 별도 구현합니다.
3. 실제 시퀀스가 있는 상태에서 QC, 플레이헤드, In/Out, 선택 클립 감지, SRT/TTS/음악 삽입을 재검증합니다.

## 10. 실제 Smoke 추가 기록 — 2026-07-12 11:08 KST

환경:

- Premiere Pro: 2026, UXP Developer Tools 연결 대상 `premierepro v26.3.0`
- UXP Developer Tools 상태: `Watching`, `Reload` 가능, `Plugin Load Successful` 확인
- 플러그인 ID: `com.seunghooda.shortflow.studio.direct`
- 로컬 후보: 당시 `npm run check` 통과. typecheck, lint, build, dist 검증, 945/945 테스트 통과. 이후 13번 기록에서 974/974 후보로 갱신됐고, 현재 최신 요약은 아래 진행 중 메모를 기준으로 합니다.
- 테스트 상태: `무제.prproj` 빈 프로젝트, 활성 시퀀스 없음

결과:

| 항목 | 상태 | 실제값 |
|---|---|---|
| 1. UXP 패널 로드 | 통과 | Premiere 화면 안에 `ShortFlow Studio` 플로팅 패널 표시. UDT에서 같은 플러그인이 `Watching` 상태로 표시됨. |
| 1-d. 최신 dist 재검증 | 통과 | `npm run check` 후 생성된 `dist`를 UDT에서 다시 load/watch 상태로 유지했습니다. |
| 3. 프로젝트·시퀀스 없음 상태 | 통과 | 빈 프로젝트에서 패널이 유지되고 Premiere 우측 패널은 `시퀀스 없음`, ShortFlow는 QC 탭과 안내 UI를 표시했습니다. |
| 3-b. 빈 프로젝트 비파괴 smoke | 제한 통과 | 활성 시퀀스가 없는 상태에서 QC 화면/버튼 접근 시 Premiere 프로젝트·타임라인 mutation 없이 상태가 유지됐습니다. |
| 10. 썸네일 Canvas 제한 UI | 제한 통과 | Premiere UXP Canvas export 제한을 코드에서 감지해 썸네일 내보내기를 비활성화하고, fallback 구현 필요 상태로 문서화했습니다. |

관찰:

- 이전 03:26 기록의 자동 조작 시간 초과 문제는 해소되어 Premiere 창 activate/click/get screenshot 조작이 가능해졌습니다.
- 현재 smoke는 빈 프로젝트 기준입니다. 실제 sequence/track/media mutation 검증은 테스트 미디어가 있는 별도 프로젝트에서만 진행해야 합니다.
- Canvas 제한은 Host 환경의 실제 기능 부재에 따른 차단 사항입니다. PNG/JPG는 계속 차단하되, 현재 빌드는 별도 `SVG fallback` 저장 버튼을 제공합니다. 이는 PNG/JPG Host export 승인을 대체하지 않습니다.

## 11. 실제 Smoke 추가 기록 — 2026-07-12 11:17 KST

환경:

- Premiere Pro: 2026, UXP Developer Tools 연결 대상 `premierepro v26.3.0`
- 테스트 자산: `host-smoke-assets/shortflow_host_smoke_9x16.mp4`, `host-smoke-assets/shortflow_host_smoke.srt`
- 로컬 후보: 당시 `npm run check` 통과. typecheck, lint, build, dist 검증, 945/945 테스트 통과. 이후 13번 기록에서 974/974 후보로 갱신됐고, 현재 최신 요약은 아래 진행 중 메모를 기준으로 합니다.

결과:

| 항목 | 상태 | 실제값 |
|---|---|---|
| 테스트 미디어 준비 | 통과 | ffmpeg로 1080×1920, 30fps, 5초, AAC 오디오 포함 MP4와 2-cue SRT를 생성했습니다. |
| 파일 가져오기 대화상자 접근 | 제한 통과 | Premiere `Ctrl+I`로 가져오기 대화상자를 열고 로컬 MP4 경로 입력까지 진행했습니다. |
| 테스트 MP4 import | 통과 | 프로젝트 패널에 `shortflow_host_smoke_9...` 클립이 표시되고 프로젝트가 수정 상태(`*`)가 됐습니다. |
| 현재 프로젝트·활성 시퀀스 감지 | 보류 | 테스트 MP4 import는 성공했지만, 화면 기준 활성 시퀀스는 아직 없습니다. |
| 실제 타임라인 mutation | 보류 | 시퀀스가 생성되지 않았으므로 SRT/TTS/음악 삽입과 자동 컷 적용은 실행하지 않았습니다. |

관찰:

- Windows 파일 대화상자는 자동 조작 포커스가 불안정해 첫 시도에서 잘못된 문자열이 파일명 칸에 입력됐습니다. 재시도 후 프로젝트 패널에 테스트 MP4가 표시되어 import 성공으로 판정했습니다.
- 프로젝트 패널 클립을 타임라인으로 드래그하거나 컨텍스트 메뉴로 새 시퀀스를 만드는 자동 조작은 실패했습니다. 따라서 실제 타임라인 mutation은 수동 시퀀스 준비 후 이어서 검증합니다.
- `host-smoke-assets/`는 로컬 smoke 전용이며 `.gitignore`에 추가했습니다.
- 이후 실제 mutation smoke는 Premiere 프로젝트 패널에 테스트 MP4가 확실히 import된 상태 또는 사용자가 수동으로 테스트 시퀀스를 만든 상태에서 이어서 진행합니다.

## 12. 실제 Smoke 추가 기록 — 2026-07-12 11:33 KST

환경:

- Premiere Pro: 2026, UXP Developer Tools 연결 대상 `premierepro v26.3.0`
- 테스트 프로젝트: 저장 전 `무제.prproj`, 수정 상태(`*`)
- 테스트 자산: `host-smoke-assets/shortflow_host_smoke_9x16.mp4`
- 로컬 후보: 당시 `npm run check` 통과. typecheck, lint, build, dist 검증, 945/945 테스트 통과. 이후 13번 기록에서 974/974 후보로 갱신됐고, 현재 최신 요약은 아래 진행 중 메모를 기준으로 합니다.

결과:

| 항목 | 상태 | 실제값 |
|---|---|---|
| 활성 시퀀스 생성 | 통과 | Premiere `파일 → 새 시퀀스` 경로로 기본 테스트 시퀀스 `시퀀스 01` 생성. 프로그램 모니터와 타임라인이 활성 시퀀스로 전환됨. |
| 현재 프로젝트·활성 시퀀스 감지 | 통과 | ShortFlow QC가 활성 시퀀스를 대상으로 실행됐고 프레임 크기 `1080×1920`, 비디오 트랙 3개, 오디오 트랙 4개를 확인함. 빈 시퀀스에서는 길이 없음 경고가 정상 표시됨. |
| 테스트 MP4 타임라인 삽입 | 통과 | 프로젝트 패널의 테스트 MP4를 소스/삽입 단축키 경로로 V1/A1에 삽입. 소스 모니터와 타임라인에서 컬러바 클립 표시 확인. |
| 길이·미디어 QC | 제한 통과 | 테스트 클립 삽입 후 QC가 길이 `00:04`를 설정 범위 내로 판정하고 비디오 트랙을 재확인함. 캡션 트랙 없음 경고는 SRT 삽입 전 정상 경고로 유지됨. |

관찰:

- 프로젝트 패널에서 타임라인으로 직접 drag-and-drop하는 자동 조작은 안정적이지 않았지만, 더블클릭 후 `,` 삽입 단축키 경로는 동작했습니다.
- 실제 SRT/캡션 삽입, TTS/음악 파일 삽입, 자동 컷/펀치인 mutation은 다음 Host gate에서 이어서 검증합니다.
- 현재까지 확인된 실제 Host 근거는 패널 로드, UDT watch/reload, 빈 프로젝트 안전 처리, MP4 import, 활성 시퀀스 생성, 테스트 클립 삽입, 기본 QC입니다.

## 13. 로컬 후보 갱신 기록 — 2026-07-12

환경:

- Premiere Pro: 2026, UXP Developer Tools 연결 대상 `premierepro v26.3.0`
- 당시 로컬 후보: `npm run check` 통과. typecheck, lint, build, dist 검증, 974/974 테스트 통과

변경 근거:

| 항목 | 상태 | 실제값 |
|---|---|---|
| QC 지연 완화 | 자동/mock 통과 | 기본 시퀀스 QC가 선택 항목과 플레이헤드 조회를 생략하는 경량 경로를 사용하고, 독립 Host 조회가 병렬 시작되는 테스트를 추가했습니다. |
| Premiere 26.3 Action 규칙 | 자동/mock 통과 | `create*Action()` 생성을 `project.lockedAccess()` 내부 factory 실행으로 지연했습니다. 실제 Host mutation은 다음 gate에서 재검증합니다. |
| Safe Zone overlay | Host 통과 | UXP Canvas에 의존하지 않고 1080×1920 BMP 가이드를 생성해 Premiere import/insert 경로에 연결했습니다. 실제 Premiere에서 ShortFlow 가이드 에셋이 프로젝트 패널에 추가되고 프로그램 모니터에 Safe Zone guide가 표시됨을 확인했습니다. |
| SRT/caption 경계 | Host 부분 통과 | 공개 UXP API에는 caption track item 생성 API가 없어 SRT는 파일 저장·프로젝트 가져오기까지를 보장하고, 실제 캡션 트랙 배치는 실험 항목으로 남깁니다. `host-smoke-assets/shortflow_smoke.srt`를 실제 파일 선택창으로 불러와 자막 편집기에 2개 cue가 표시됨을 확인했습니다. |
| 음악/SFX 폴더 동기화·삽입 | Host 통과 | `host-smoke-assets`를 자산 루트로 선택하고 `SFX/shortflow_smoke.wav`를 동기화했습니다. 작은 floating panel에서 자산 브라우저가 보이도록 flex-wrap/order 레이아웃을 보강한 뒤 WAV 카드가 표시됐고, 같은 패널 DOM의 `dblclick` 이벤트로 Premiere 프로젝트 import와 A1 타임라인 삽입을 확인했습니다. |

남은 Host gate:

- 최신 `dist`를 UDT에서 reload한 뒤 QC 지연 ms 로그를 실제 시퀀스에서 다시 측정합니다.
- 플레이헤드, In/Out, 선택 클립 감지, TTS live/API 경로, 자동 컷/펀치인 복제 시퀀스 적용을 같은 테스트 프로젝트에서 재검증합니다.

## 14. 실제 Smoke 추가 기록 — 2026-07-12 13:45 KST

환경:

- Premiere Pro: 2026, 테스트 프로젝트 `무제.prproj`, 활성 시퀀스 `시퀀스 01`
- 당시 로컬 후보: `npm run check` 통과. typecheck, lint, build, dist 검증, 974/974 테스트 통과
- 릴리스 후보: `npm run package:ccx:force`와 `npm run verify:release` 통과. SHA-256 `dadc2dd405a8facceca761175d63360b140b0e8d30fe783d167d3c8cedc50df8`. 이 파일은 Adobe 서명 전 로컬 검증 후보이며, 최종 내부 베타 승인·체크포인트 커밋·GitHub push를 의미하지 않습니다.

결과:

| 항목 | 상태 | 실제값 |
|---|---|---|
| 패널 재오픈 | 통과 | Premiere `창 → UXP 플러그인 → ShortFlow Studio`에서 패널을 닫은 뒤 다시 열 수 있음을 확인했습니다. |
| 실제 QC 재실행 | 통과 | QC 버튼이 실제 Host에서 실행되어 `1080×1920`, 비디오 트랙 3개, 길이 약 `00:04.7`을 다시 감지했습니다. 캡션 트랙 없음 경고는 SRT 삽입 전 정상 경고로 유지합니다. |
| 마커 배치 탭 가시성 | 통과 | 오래된 설치·캐시 패널에서는 카드가 보이지 않았으나, UXP Developer Tools에 현재 `dist/manifest.json`을 등록하고 Reload한 뒤 `마커 배치` 탭의 설정 카드와 `+ 스토리 마커 추가` 버튼이 표시됐습니다. |
| 마커 탭 레이아웃 수정 | Host 통과 | `.two-column-layout`을 CSS Grid 고정 2열에서 `flex-wrap` 기반으로 변경하고 UI 계약 테스트를 추가했습니다. 실제 Premiere 패널에서 소형 floating width에서도 카드와 버튼이 표시됨을 확인했습니다. |
| 탭 전환 안정화 | Host 통과 | UXP Reload 후 마커 탭 클릭 시 `스토리 마커 배치` 패널로 전환됐습니다. UXP DOM 준비 시점 흔들림을 줄이기 위해 탭 초기화를 DOM-ready + 문서 레벨 이벤트 위임 방식으로 변경했습니다. |
| Safe Zone overlay context guard | Host 통과 | Safe Zone BMP overlay 생성 시 `readActiveContextKey()`로 캡처한 컨텍스트를 `readSequenceStatus(undefined, { expectedContextKey })`와 `importAndInsertAsset(... expectedContextKey)` 양쪽에 전달하도록 보강했습니다. 실제 overlay 삽입 smoke에서 ShortFlow 가이드 에셋 import와 프로그램 모니터 표시를 확인했습니다. |

관찰:

- UXP Developer Tools workspace에 현재 `dist/manifest.json`을 등록한 뒤 `Plugin Reload Successful` 메시지를 확인했습니다.
- Reload 전의 설치·캐시 패널과 Reload 후의 최신 `dist` 패널이 다르게 동작할 수 있으므로, Host smoke 전에는 UDT Reload 또는 최신 CCX 재설치를 먼저 수행해야 합니다.
- 다음 Host gate에서는 SRT 가져오기, TTS/음악 삽입, 자동 컷/펀치인 복제 시퀀스 적용을 같은 테스트 프로젝트에서 이어서 검증합니다.

## 15. 진행 중 Host 확인 메모 — 2026-07-12

현재 확인된 Host 상태:

- Premiere Pro와 UXP Developer Tools가 실행 중이며, ShortFlow Studio 패널이 로드된 상태입니다.
- UXP Developer Tools에서 `Reload` 성공과 debug window 오픈을 확인했습니다.
- 실제 Premiere QC에서 활성 시퀀스가 `1080×1920`, 길이 약 `00:04`, 비디오 트랙 3개, 오디오 트랙 4개로 감지됐습니다.
- 캡션 트랙 없음 경고는 SRT 삽입 전 정상 경고로 기록합니다.

최근 로컬 targeted 검증:

- `npm run typecheck` 통과
- `npm run build` 통과
- compiled automation fallback/controller tests 통과: 11/11
- `npm run check` 통과: typecheck, lint, build, dist 검증, 1008/1008 tests

추가 Host 확인:

- 작은 floating panel에서 Automation 탭 카드가 보이지 않는 문제가 재현되어, `flex-wrap` 기반 레이아웃과 workspace 내부 스크롤을 보강했습니다. 실제 Host에서 Automation 카드와 Safe Zone 카드 DOM을 확인했고, Debug console을 통해 같은 패널 컨텍스트에서 `safe-overlay-btn` 클릭 이벤트를 실행했습니다.
- Safe Zone BMP overlay 실제 삽입 smoke는 통과했습니다. Premiere 프로젝트 패널에 ShortFlow 가이드 에셋이 추가되고 프로그램 모니터에 Safe Zone guide가 표시됐습니다. export 전 삭제 경고와 최종 QC guide-removal 항목은 최종 export gate에서 다시 확인합니다.
- SRT 파일 import smoke는 통과했습니다. `host-smoke-assets/shortflow_smoke.srt`를 실제 파일 선택창으로 열었고, 자막 편집기에 2개 cue와 단어 chip이 표시됐습니다. 캡션 트랙 자동 배치는 공개 UXP API 제한 때문에 성공 범위로 보지 않습니다.
- SRT로 가져온 자막 문서를 자동 컷 transcript fallback으로 연결했습니다. 실제 Host 디버그 상태에서 Automation 탭이 `자막: project ... · 2개 타임코드`를 표시함을 확인했고, 분석 버튼에서 STT 빈 상태가 SRT 입력을 덮어쓰는 버그를 수정했습니다. 수정 후 typecheck, 관련 49개 테스트, build/dist 검증을 통과했습니다.
- 상태 UI에 플레이헤드와 In/Out 항목을 추가했고, 실제 Host 디버그 출력에서 `playhead: 00:04`, `inout: 00:00 → 00:00` 읽기를 확인했습니다. 이후 실제 타임라인 TrackItem 선택 상태에서 fallback 선택 감지와 패널 상태 UI `타임라인 4개 선택 · 00:06` 표시까지 확인했습니다.
- 상단 상태 영역이 작은 Premiere floating panel에서 밀릴 수 있어 QC 탭 내부에도 시퀀스/프레임/길이/재생 위치/선택 요약 스트립을 추가했습니다. HTML/JS/CSS 계약, dist 검증과 `npm run check`는 통과했지만 실제 패널 시각 확인은 다음 Host UX pass에서 다시 확인합니다.
- 음악/SFX smoke는 통과했습니다. `host-smoke-assets` 폴더를 자산 루트로 선택하고 `SFX/shortflow_smoke.wav`를 동기화한 뒤, Premiere 프로젝트 패널에 WAV 에셋이 추가되고 A1 타임라인에 오디오 클립이 삽입됐습니다.
- 작은 floating panel에서 자산 브라우저가 오른쪽으로 밀려 보이지 않는 문제가 재현되어, `asset-workspace`를 `flex-wrap` 레이아웃으로 바꾸고 narrow width에서 라이브러리를 먼저 표시하도록 보강했습니다. 실제 Host에서 자산 카드 표시를 확인했습니다.

진행 중/다음 검증:

- TTS live/API 경로와 자동 컷·펀치인 복제 시퀀스 적용은 같은 테스트 프로젝트에서 이어서 검증합니다.

## 16. 실제 Smoke 추가 기록 — 2026-07-12 현재 세션

환경:

- Premiere Pro: 2026, UXP Developer Tools 연결 대상 `premierepro v26.3.0`
- 테스트 프로젝트: `무제.prproj`, 활성 시퀀스 `시퀀스 01`
- 로컬 후보: `npm run check` 통과. typecheck, lint, build, dist 검증, 1008/1008 tests

결과:

| 항목 | 상태 | 실제값 |
|---|---|---|
| 실제 QC 패널 실행 | Host 통과 | Premiere 안의 ShortFlow floating panel에서 `QC 검사 실행` 버튼과 결과 카드가 표시됐습니다. |
| 잘못된 프레임 규격 감지 | Host 통과 | 현재 활성 시퀀스가 `1920×1080`으로 읽혀, QC 결과가 `프레임 크기를 1080×1920로 맞춰 주세요.`를 표시했습니다. 이는 9:16 내부 베타 기준의 규격 오류 감지 smoke로 기록합니다. |
| 길이·트랙 감지 | Host 통과 | 같은 QC 결과에서 길이 `00:06`이 설정 범위 안으로 표시되고, 비디오 트랙 4개와 오디오 트랙 4개가 감지됐습니다. |
| 캡션 트랙 없음 경고 | Host 통과/정상 경고 | SRT/캡션 삽입 전 상태이므로 `캡션 트랙이 없습니다. 무음 시청 환경을...` 경고가 정상적으로 표시됐습니다. |
| 선택 클립 감지 | Host 통과 | `sequence.getSelection().getTrackItems()`는 빈 배열을 반환했지만, 개별 TrackItem `getIsSelected()` fallback으로 video/audio TrackItem 4개 선택을 확인했고 ShortFlow 상태 UI가 `타임라인 4개 선택 · 00:06`으로 갱신됐습니다. |

관찰:

- 이번 smoke는 이전 9:16 정상 시퀀스 확인과 별개로, 가로 시퀀스에서 QC가 잘못된 규격을 차단하는지 확인한 기록입니다.
- QC 내부 상태 스트립은 HTML/JS/CSS 계약과 `dist` 검증은 통과했지만, 현재 작은 floating panel 화면에서는 결과 카드가 먼저 보이고 스트립은 명확히 시각 확인되지 않았습니다. 다음 Host UX pass에서 계속 확인합니다.

## 17. 실제 Smoke 추가 기록 — 2026-07-12 현재 세션

환경:

- Premiere Pro: 2026, UXP Developer Tools 연결 대상 `premierepro v26.3.0`
- 테스트 프로젝트: `무제.prproj`, 활성 시퀀스 `시퀀스 01`
- 로컬 후보: TTS/STT floating panel 레이아웃 수정 후 `npm run check` 통과. typecheck, lint, build, dist 검증, 1008/1008 tests

결과:

| 항목 | 상태 | 실제값 |
|---|---|---|
| TTS/STT 탭 접근성 | Host 통과 | 작은 Premiere floating panel에서 탭바를 스크롤해 `TTS-STT` 탭을 노출하고 클릭할 수 있음을 확인했습니다. |
| TTS 카드 가시성 | Host 통과 | `speech-workspace`를 `flex-wrap` 기반으로 보강한 뒤 `TTS · 대본을 음성으로` 카드, 대본 입력, 저장 폴더 선택, 자동 삽입 옵션, 오디오 트랙 입력, `음성 생성 및 저장` 버튼까지 실제 Host에서 접근 가능함을 확인했습니다. |
| TTS live/API 삽입 | 보류 | API key와 실제 전송 승인을 사용하지 않았으므로 OpenAI TTS 호출과 생성 파일 타임라인 삽입은 아직 통과로 판정하지 않습니다. |
| 자동 컷·펀치인 입력 없음 상태 | Host 통과 | `자동 편집` 탭에서 STT/SRT transcript가 없는 상태일 때 `STT 결과가 비어있어 아직 자동 편집을 사용할 수 없습니다. 다시 분석해 주세요.` 안내와 비활성 실행 버튼을 확인했습니다. 프로젝트 mutation 없음. |
| 자동 컷·펀치인 dry-run/추천 마커 | Host 통과 | SRT fallback으로 `2개 타임코드` 분석, marker/apply 버튼 활성화, 추천 마커 `1개 추가 완료` 로그를 확인했습니다. |
| 자동 컷·펀치인 복제 시퀀스 적용 | Mock 보강 후 Host 재검증 필요 | 실제 apply 시 SRT fallback transcript를 재조회하지 못해 `TTS/STT 필요` 상태로 돌아가는 버그를 발견했습니다. analyzed SRT fallback 유지, 복제 준비 실패 시 원본 재활성화·복제본 정리, 클립 경계 펀치인 키프레임 회귀 테스트를 추가했고 `npm run check`가 통과했습니다. 새 build 적용 후 Host에서 다시 실행해야 합니다. |

관찰:

- TTS/STT 레이아웃은 자산·자동화 탭과 동일하게 `flex-wrap` 기반으로 변경했습니다. Premiere floating panel에서 CSS viewport와 보이는 패널 폭이 다르게 잡히는 경우에도 핵심 카드가 가로 밖으로 밀리지 않게 하기 위한 수정입니다.
- 선택 클립 감지 문구는 `타임라인 선택` 기준으로 보강했습니다. Premiere 프로젝트 패널 또는 속성 패널 선택과 타임라인 TrackItem 선택 차이를 실제 Host에서 확인했고, `getSelection()` empty/fail 시 TrackItem `getIsSelected()` fallback으로 복구하도록 했습니다.

## 18. 문서 정합성 수정 후 로컬 재검증 — 2026-07-12

목적:

- 실제 Host smoke 기록과 Mock 기준선 문서가 서로 다른 완료 범위를 암시하지 않도록 정리했습니다.
- README, 로드맵, 요구사항 추적표, QA 체크리스트에서 내부 베타 AI 범위를 “외부 산출물/레퍼런스/권리 기록”으로 좁히고, AI 이미지·영상 생성 파이프라인은 후순위로 유지했습니다.
- 음악/SFX는 실제 Host에서 WAV A1 기본 삽입까지 확인했고, 미리듣기·드래그 순서 이동·잠긴 트랙/충돌 경고는 최종 승인 전 추가 확인으로 분리했습니다.
- 썸네일은 로컬/mock PNG/JPG 로직과 실제 Host SVG fallback 경로를 분리해 기록했습니다.

로컬 검증:

- `npm run check` 통과
- typecheck, lint, build, dist 검증 통과
- 전체 테스트 `1008/1008` 통과, 실패 0

남은 Host gate:

1. TTS live/API 생성, 저장, Premiere import, 지정 트랙 삽입
2. SRT fixture 기반 자동 컷·펀치인 dry-run, 추천 마커 추가, 복제 시퀀스 적용
3. 최종 QC/권리 리포트/복구·진단 로그 Host 확인

## 19. 실제 Host 재접속 확인 — 2026-07-12 17:00 KST

목적:

- 이전 Windows 앱 자동 조작 시간 초과 이후, 현재 세션에서 Premiere와 UXP Developer Tools가 다시 제어 가능한지 확인했습니다.
- 이번 기록은 실제 mutation을 추가로 수행하지 않는 읽기 중심 확인입니다.

확인 결과:

| 항목 | 상태 | 근거 |
|---|---|---|
| Premiere 창 접근 | 통과 | `Adobe Premiere - ... 무제 *` 창을 활성화하고 화면 캡처를 획득했습니다. |
| UXP Debug 창 접근 | 통과 | `ShortFlow Studio - Premiere Pro v26.3.0 (Debug)` 창을 활성화하고 플러그인 콘솔에서 DOM 쿼리를 실행했습니다. |
| ShortFlow 패널 표시 | 통과 | Premiere 좌측 floating panel에 `ShortFlow Studio`가 표시되고 자동 편집 탭 카드가 보였습니다. |
| 실제 타임라인 상태 | 제한 통과 | `시퀀스 01` 타임라인, Safe Zone 가이드 오버레이, `shortflow_smoke.wav` 프로젝트 항목/속성 패널 표시, A1 트랙 삽입 상태가 화면에서 확인됐습니다. |
| Premiere track item 조회 | 통과 | UXP 콘솔에서 `await sequence.getVideoTrack(i)`/`await sequence.getAudioTrack(i)` 경로로 track item 수를 직접 조회했습니다. 결과는 `video: [1,0,0,1]`, `audio: [1,1,0,0]`입니다. |
| Premiere selection API 직접 조회 | 제한 통과/Host 차이 발견 | `sequence.getSelection().getTrackItems()` 직접 조회 결과는 `count: 0`이지만, 개별 TrackItem `getIsSelected()` 조회에서는 선택 상태가 true로 반영됐습니다. 현재 프로젝트 패널/속성 패널 선택과 타임라인 TrackItem 선택은 구분해 기록합니다. |
| TrackItem fallback 선택 감지 | Host 통과 | UXP Debug Console에서 timeline fallback 직접 조회 결과 `SF_ALL_ITEMS_SELECTED`가 video/audio TrackItem 4개를 반환했고 각 항목의 `selected: true`를 확인했습니다. 최신 `dist` reload 후 `#refresh-btn` 클릭으로 ShortFlow 상태 UI가 `타임라인 4개 선택 · 00:06`으로 갱신됐습니다. |
| 자동 편집 안전 차단 | 통과 | 패널 본문에서 `STT 결과가 비어있어 아직 자동 편집을 사용할 수 없습니다. 다시 분석해 주세요.` 안내와 복제 시퀀스 적용 버튼의 제한 상태를 확인했습니다. |
| 현재 Mock 기준선 | 통과 | selection fallback, TTS 응답 컨테이너 검증, 자동화 host mutation snapshot guard와 SRT fallback 유지, clone 준비 실패 정리, 클립 경계 펀치인 키프레임 회귀, 로컬 Whisper 오프라인 검증 스크립트와 Whisper JSON 자막 변환 계약 추가 후 `npm run check`가 typecheck, lint, build, dist 검증, 1008/1008 tests로 통과했습니다. |
| 베타 증거 템플릿 | 통과 | `beta-evidence/ShortFlow_Beta_Evidence_20260712T111256Z.md`를 생성했습니다. |
| 로컬 Whisper 오프라인 STT smoke | 통과/Host 대체 아님 | `local-whisper-evidence/20260712T110447Z/ShortFlow_Local_Whisper_Evidence_20260712T110447Z.md`에서 base/cpu, 2개 segment, 9개 word timestamp, 생성 샘플 키워드 4/4를 확인했습니다. OpenAI live API, TTS 생성, Premiere Host 삽입 gate는 아직 통과로 판정하지 않습니다. |

아직 통과로 판정하지 않는 항목:

- TTS live/API 삽입: API 호출·파일 저장·Premiere import·지정 트랙 삽입은 아직 실행하지 않았습니다.
- 자동 컷 복제 시퀀스 적용: dry-run과 추천 마커 추가는 Host에서 통과했습니다. SRT fallback 유지와 복제 준비 실패 정리는 Mock 회귀 테스트로 보강했으며, 새 빌드 적용 상태에서 실제 Host 복제 적용을 재검증해야 합니다.

## 20. 자동 컷·펀치인 복제 적용 재검증 — 2026-07-12 21:17 KST

사용 입력:

- `tests/shortflow_automation_gap.srt`
- 3개 cue, 무음 간격 2개, 기본 `minSilence=0.42`
- 원본 시퀀스: `시퀀스 01`

결과:

| 항목 | 상태 | 실제값 |
|---|---|---|
| SRT fallback 분석 | Host 통과 | CUT 2개(`00:01.08–00:01.92`, `00:03.08–00:04.42`), ZOOM 2개(`00:02.05–00:02.95`, `00:04.55–00:05.45`) |
| 원본 보존 | Host 통과 | 원본 `시퀀스 01` 탭이 그대로 유지됨 |
| 복제 생성·활성화 | Host 통과 | `시퀀스 01_ShortFlow_Auto_20260712121754 2` 생성 후 활성 시퀀스로 전환됨 |
| 자동 편집 마커 | Host 통과 | 타임라인과 Program Monitor에 `SF CUT 01`, `SF ZOOM`, `SF CUT 02`, `SF ZOOM` 표시 |
| 비파괴 기본 경로 | Host 통과 | 원본을 직접 변경하지 않고 복제본에만 적용 |

제한:

- 공개 Premiere UXP API 제약으로 CUT은 실제 razor 삭제가 아니라 `SF CUT` 검토 마커입니다.
- Motion 펀치인 키프레임의 시각적 보간·easing 품질은 별도 플레이백 QA에서 추가 확인합니다.
- TTS live/API 삽입은 API key를 사용하지 않았으므로 계속 보류합니다.
