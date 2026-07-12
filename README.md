# ShortFlow Studio

ShortFlow Studio는 Adobe Premiere Pro용 UXP 숏폼 제작 패널입니다. 현재 목표는 **한 달 안에 Premiere 내부 베타를 완성**하는 것이며, 판매·상용화보다 실제 편집 시간을 줄이는 로컬 기능과 안정성에 집중합니다.

## 현재 검증 상태

현재는 Mock Host와 실제 Premiere 개발 로드 확인을 분리해 검증하고 있습니다. Premiere/UXP 기본 로드, 패널 표시, 테스트 MP4 프로젝트 import, 활성 시퀀스 생성, 기본 QC, Safe Zone BMP overlay, SRT 파일 import, 음악/SFX 폴더 동기화와 WAV A1 삽입, 타임라인 TrackItem 선택 감지, 자동 컷 dry-run과 추천 마커 추가를 실제 Host smoke로 확인했습니다. 추가로 무음 간격 SRT를 사용해 원본 시퀀스를 보존하고 새 복제 시퀀스에 `SF CUT 01/02`와 `SF ZOOM` 마커를 적용하는 기본 자동 컷·펀치인 Host 경로도 통과했습니다. TTS live/API 삽입은 내부 베타 최종 승인 전 별도 Host gate로 수행합니다.

- 범위 재정의 직전 Node 기반 정적/mock 기준선: **864개 통과**
- 현재 Mock 기준선: **전체 1008/1008 통과**
- 현재 TypeScript, 전체 ESLint, Vite build, `dist` 구조 검증 통과
- 이전 로컬 CCX 후보와 SHA-256은 `npm run beta:evidence:verified`로 생성·검증했습니다. 이후 소스가 변경됐으므로 최종 내부 베타 후보는 남은 Host gate 통과 후 다시 생성합니다.
- Premiere Pro/UXP Developer Tool 실제 실행: **기본 로드, UDT watch/reload, 패널 표시, 테스트 MP4 import, 활성 시퀀스 기본 QC, Safe Zone overlay, SRT import, 음악/SFX WAV 삽입, TrackItem 선택 감지, 자동 컷·펀치인 복제 적용 확인**
- TTS live/API 삽입, Media Encoder, Windows/macOS CCX 설치, Adobe 서명, Marketplace 심사: **아직 완료하지 않음**

자동 테스트는 순수 로직과 어댑터 경계를 검증하지만 Premiere 프로젝트 변경, UXP 버전 차이, 파일 권한, Media Encoder 연동과 실제 렌더 결과를 보증하지 않습니다. 현재 포함·제외 기준은 [내부 베타 범위](docs/INTERNAL_BETA_SCOPE.md), 4주 진행 순서는 [로드맵](docs/ROADMAP.md), 설치 후 검증은 [실제 Host smoke runbook](docs/HOST_BETA_RUNBOOK.md), 전체 검증은 [QA 체크리스트](docs/QA_CHECKLIST.md)와 [요구사항 추적표](docs/REQUIREMENTS_MATRIX.md)를 확인해 주세요.

## 내부 베타 범위 요약

내부 베타에는 자막/STT/SRT, 단어 타임스탬프 편집, 기본 TTS, 음악/SFX 폴더와 삽입, 수동 썸네일, Safe Zone, 기본 자동 컷/펀치인, 로컬 설정·복구·진단, 에셋 권리 관리와 자동 품질 게이트를 포함합니다.

결제·라이선스·SaaS 서버, 자동 텔레메트리 서버, AI 이미지·영상 생성 전체 파이프라인, 썸네일 AI 대화/A-B 판단, 고급 비트 매칭·자동 덕킹, 다국어·스마트 리프레임·업로드 패키지는 후순위입니다. 기존 코드가 있더라도 현재 추가 확장하지 않습니다.

## 요구 사항

- Adobe Premiere Pro 25.6 이상
- UXP Developer Tool 2.2 이상(개발 로드)
- Node.js 20.19 이상(개발·검사·패키징)
- npm
- 영상 내보내기 시 Adobe Media Encoder와 유효한 `.epr` 프리셋
- AI 기능 사용 시 사용자가 소유하고 비용·사용량을 관리하는 OpenAI API key

## 기능과 연결 상태

### 현재 패널에서 초기화되는 기능

- 활성 프로젝트/시퀀스 상태, 기본 QC, 플랫폼 규격과 선택 범위
- 원본을 복제한 뒤 실행하는 세로 숏폼 시퀀스 생성, 마커 구간 일괄 생성
- 스케일·위치 기반 `fill`/`fit` 리프레임, 훅/CTA 마커
- MOGRT 삽입, Media Encoder 프리셋 내보내기, 현재 프레임 커버 저장
- persistent token 기반 자산 루트, Music/SFX/References/Thumbnails/Exports 구조, 재귀 검색·필터·정렬
- 이미지/영상 레퍼런스 보드, 프롬프트 메모·태그·출처 기록, 에셋 권리 정보 연계
- 최대 4개 레이어, 6개 레이아웃, 밝기·대비·채도·그림자·광선과 PNG/JPG 저장을 지원하는 썸네일 랩. Premiere Pro 26.3 UXP Canvas 제한 환경에서는 PNG/JPG 버튼을 비활성화하고 이미지 data URL을 내장하는 SVG fallback 저장 버튼을 제공합니다.
- TTS/STT 파일 선택, 생성 결과 저장과 Premiere 오디오 삽입 흐름
- STT 결과 연계, 단어 편집/숨김/합치기, 큐 분할·병합·재배치, undo/redo, autosave와 SRT 입출력을 지원하는 자막 편집기
- STT 구간 기반 무음 컷 계획, 최대 컷 수 방어, 강조 펀치 큐/키프레임 계획, revision이 표시되는 보수적 플랫폼 Safe Zone. Premiere 26.3에서는 Action factory를 `lockedAccess()` 내부에서 실행하고, Safe Zone 가이드는 Canvas 없이 BMP로 생성합니다.
- 최대 20개 브랜드 키트와 폰트·색상·로고·자막·썸네일·TTS·MOGRT 기본값
- AI 작업 큐의 중복 제거, 취소, 재시도, 동시 실행 수, provider-unit 일일 한도와 승인 임계값
- clone-before-mutation 검증, 최대 50개 작업 저널, 중단 작업 복원과 검증된 복제 시퀀스 rollback을 제공하는 비파괴 복구 흐름
- 실제 시퀀스·미디어 상태와 STT/Safe Zone revision·사용자 입력 오디오 값을 수집하는 최종 QC, waiver, JSON/Markdown 보고서와 내보내기 차단 게이트
- Premiere/UXP capability 진단 실행, 민감정보를 제거한 로컬 JSON 진단 번들 저장, 복구 저널 목록과 검증된 복제본 제거 UI

이 기능들은 패널 초기화 흐름에 연결되어 있고 UXP 개발 로드로 패널 표시와 테스트 MP4 import까지 확인했습니다. 운영 배포 전에는 테스트 프로젝트에서 활성 시퀀스, 파일 권한, 시퀀스 mutation, Canvas 대체 저장 경로, Media Encoder, 진단 probe 결과를 직접 확인해야 합니다.

## AI 이미지·음성

### 이미지 편집

- 모델은 `gpt-image-2`만 사용합니다.
- `basic`, `vivid`, `upscale`, `remove-bg`, 자유 대화형 prompt를 지원합니다.
- 입력 이미지는 최대 4개, 각 10MB 이하의 PNG/JPEG/WebP입니다.
- 패널의 이미지·음성·텍스트 AI 요청은 `https://api.openai.com/v1` 공식 API로만 전송합니다. 저장된 레거시 endpoint/provider 값도 실행 전에 공식 origin으로 정규화합니다.
- manifest 네트워크 허용 대상은 `https://api.openai.com`뿐이며 패널에서 custom endpoint/provider를 지원하지 않습니다.
- 이미지 편집 코드는 회귀 보호를 위해 유지하지만, 내부 베타 UI에서는 썸네일 AI 보정을 숨김·비활성 상태로 둡니다. 내부 베타의 AI 이미지·영상 범위는 레퍼런스 보드와 외부 파일 정리입니다.

### TTS

- 대본은 요청당 최대 **4,096자**입니다.
- 속도 범위는 0.25~4배이며 WAV/MP3/AAC/FLAC 저장을 지원합니다.
- `gpt-4o-mini-tts`, `tts-1-hd`, `tts-1`과 코드에 정의된 모델별 voice를 사용합니다.
- OpenAI 공식 안내에 따라, 생성 음성을 듣는 최종 사용자에게 **AI가 생성한 음성이며 실제 사람의 음성이 아니라는 사실을 명확히 고지해야 합니다**. 자세한 내용은 [OpenAI Text-to-Speech 가이드](https://developers.openai.com/api/docs/guides/text-to-speech)를 확인해 주세요.

### STT

- 입력 파일은 최대 **25MB**입니다.
- MP3/MP4/MPEG/MPGA/M4A/WAV/WebM 입력을 검사합니다.
- 기본 `gpt-4o-transcribe-diarize`는 `diarized_json`과 `chunking_strategy=auto`를 사용합니다.
- `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`도 지원하며 결과를 텍스트/SRT로 저장할 수 있습니다.

## API key와 개인정보

- OpenAI API key는 `shortflow.openai.apiKey` 키로 UXP `secureStorage`에 저장하도록 구현되어 있습니다. API key를 `localStorage`, 설정 JSON, 작업 로그 또는 진단 번들에 넣지 마세요.
- 모델명, 파일 접근 persistent token과 비밀이 아닌 UI 설정/메타데이터는 로컬 저장소를 사용할 수 있습니다. 레거시 endpoint/provider 저장값은 공식 OpenAI API 값으로 정규화됩니다.
- AI 실행 시 사용자가 선택한 이미지, 음성 파일, 대본, prompt 또는 자막 텍스트가 OpenAI 공식 API로 전송됩니다. 전송 권한이 없는 개인정보·미공개 영상·음성을 사용하지 마세요.
- 패널 AI 기능은 이미지·음성·텍스트 전송 전 사용자의 명시적 AI 전송 동의를 요구하도록 연결되어 있습니다.
- OpenAI API 데이터 정책과 보존 설정은 플러그인이 통제하지 않습니다. 조직의 최신 설정과 [OpenAI business data 안내](https://openai.com/business-data/)를 배포 전에 확인해 주세요.
- 진단 모듈의 telemetry 기본값은 opt-out이며 명시적 `setOptIn(true)` 없이는 이벤트를 만들지 않습니다. 현재 패널은 telemetry provider를 초기화하지 않으므로 원격 telemetry 전송이 연결되어 있지 않습니다. 향후 provider를 연결할 경우 사전 동의, allowlist, 개인정보 처리방침과 철회/삭제 UI가 필요합니다.

## 개발 환경 설치

저장소의 `plugin` 디렉터리에서 실행합니다.

### Windows PowerShell

```powershell
npm install
npm run check
```

### macOS Terminal

```bash
npm install
npm run check
```

주요 명령은 다음과 같습니다.

- `npm run typecheck`: strict TypeScript 검사
- `npm run lint`: ESLint
- `npm test`: mock/순수 모듈 테스트
- `npm run build`: Vite build 후 `dist` 검증
- `npm run verify:dist`: 기존 `dist`만 재검증
- `npm run verify:release`: 기존 `release`의 CCX 후보, SHA-256 파일, CCX 내부 루트 구조와 금지 경로 재검증
- `npm run beta:evidence`: 현재 `dist`/`release` 상태를 기반으로 내부 베타 증거 템플릿 생성
- `npm run beta:evidence:verified`: `check`, CCX 패키징, 릴리스 검증을 모두 통과한 뒤 검증 표시된 내부 베타 증거 파일 생성
- `npm run verify:speech`: OpenAI 키 없이 TTS/STT smoke 검증 계획과 증거 템플릿 생성
- `npm run verify:speech:live`: `OPENAI_API_KEY` 환경변수로 실제 OpenAI TTS→STT smoke 검증 실행
- `npm run verify:speech:local`: 로컬 `openai-whisper` 패키지로 한국어 테스트 WAV를 전사하고 TXT/SRT/단어 타임스탬프 JSON 검증
- `npm run check`: typecheck, lint, test, build 전체 게이트
- `npm run package:ccx`: CCX 후보와 SHA-256 생성 후 릴리스 산출물 검증
- `npm run package:ccx:force`: 같은 버전의 서로 다른 기존 CCX를 명시적으로 교체 후 릴리스 산출물 검증
- `npm run clean`: build/test/release 산출물 정리

참고: `verify:release`는 현재 `release/`에 있는 기존 CCX를 검사합니다. 기존 로컬 후보는 `beta:evidence:verified`로 생성·검증했지만, 이후 소스가 변경됐으므로 남은 Host gate 통과와 최종 체크포인트 재검증 전까지 내부 베타 승인 산출물로 고정하지 않습니다.

## UXP Developer Tool 개발 로드

Windows와 macOS 모두 다음 절차를 사용합니다.

1. Premiere Pro 25.6 이상과 UXP Developer Tool 2.2 이상을 설치하고 실행합니다.
2. `npm run build`를 실행합니다.
3. UXP Developer Tool의 **Add Plugin**에서 소스 manifest가 아닌 `plugin/dist/manifest.json`을 선택합니다.
4. **Load** 후 Premiere Pro의 **창 > UXP 플러그인 > ShortFlow Studio**에서 패널을 엽니다.
5. 코드를 변경하면 build 완료 후 **Reload**합니다.

이 절차는 Windows 개발 환경에서 UXP Developer Tool `Load`와 Premiere 패널 표시까지 확인했습니다. 메뉴명은 설치된 Premiere/UXP 버전과 언어에 따라 다를 수 있습니다.

## TTS/STT 실제 smoke 검증

Premiere를 설치할 수 없는 환경에서도 OpenAI Speech API 자체는 별도 smoke 검증할 수 있습니다.

```powershell
npm run verify:speech
```

실제 API 호출은 명시적으로 `OPENAI_API_KEY`를 설정한 뒤 실행합니다. 이 명령은 짧은 비민감 한국어 문장으로 TTS WAV를 생성하고, 그 WAV를 다시 STT로 전사해 결과와 증거 파일을 `speech-evidence/`에 저장합니다. API key, Authorization header와 원본 오디오 bytes는 증거 파일에 저장하지 않습니다.

```powershell
$env:OPENAI_API_KEY="sk-..."
npm run verify:speech:live
Remove-Item Env:\OPENAI_API_KEY
```

`speech-evidence/`는 Git에서 제외됩니다. 이 smoke 검증은 OpenAI TTS/STT 요청 경로 확인이며, Premiere 오디오 트랙 삽입이나 UXP 파일 권한 검증을 대체하지 않습니다.

### 로컬 Whisper smoke 검증

로컬 검증은 API key와 원격 STT 호출 없이 자막·자동 편집 입력을 확인하기 위한 개발 도구입니다. Python 3.11과 `ffmpeg`가 PATH에 있어야 합니다. 가상환경은 `%LOCALAPPDATA%\ShortFlowStudio\whisper\.venv`에 두고, 검증 기준인 `openai-whisper 20250625`를 설치합니다. 기본 `base` 모델은 첫 실행 때 `%LOCALAPPDATA%\ShortFlowStudio\whisper\models`에 내려받습니다.

```powershell
$whisperRoot = Join-Path $env:LOCALAPPDATA "ShortFlowStudio\whisper"
ffmpeg -version
py -3.11 -m venv (Join-Path $whisperRoot ".venv")
& (Join-Path $whisperRoot ".venv\Scripts\python.exe") -m pip install "openai-whisper==20250625"
npm run verify:speech:local
```

기본 실행은 Windows의 한국어 음성으로 짧은 WAV를 만든 뒤 CPU에서 전사합니다. 더 높은 정확도를 비교할 때는 스크립트를 직접 실행해 `-Model small`을 지정할 수 있습니다. 자막 편집기의 `SRT/Whisper JSON 불러오기` 버튼은 UTF-8 `.srt` 또는 단어 타임스탬프가 있는 공식 Whisper `.json` 출력을 자동 판별하며, JSON 단어 시간을 비례 보간하지 않고 그대로 보존합니다. 결과와 증거는 Git에서 제외되는 `local-whisper-evidence/`에 저장됩니다. 이 경로는 제품 UXP 패널의 provider나 배포물에 포함되지 않으며, OpenAI live API smoke 또는 Premiere Host 오디오 삽입 gate 통과를 의미하지 않습니다.

## CCX 후보 패키징과 설치

```powershell
npm run check
npm run package:ccx
```

생성 파일:

- `release/ShortFlow-Studio-<version>.ccx`
- `release/ShortFlow-Studio-<version>.ccx.sha256.txt`
- `beta-evidence/ShortFlow_Beta_Evidence_<timestamp>.md` (`npm run beta:evidence` 또는 `npm run beta:evidence:verified` 실행 시)

패키징 스크립트는 `dist` 내용만 ZIP/CCX 루트에 고정 순서·날짜로 넣어 재현 가능한 SHA-256을 계산합니다. 기존 같은 버전 파일과 새 내용이 다르면 서명된 파일의 우발적 덮어쓰기를 막기 위해 중단합니다.
패키징 후 `verify:release`가 체크섬 파일, 파일명, 파일 크기, 임시 파일 잔여 여부와 CCX 내부 루트 구조를 다시 확인합니다. CCX 내부에는 `manifest.json`, `index.html`, `index.js`, `styles.css`, 아이콘 파일이 루트 기준으로 있어야 하며 `dist/`, `src/`, `tests/`, `node_modules/`, `.git/`, `.env*`, key/credentials류 파일은 허용하지 않습니다.

중요: 이 명령은 **Adobe 서명, notarization, 조직 배포 승인 또는 Marketplace 심사를 수행하지 않습니다.** 생성물은 서명 전 릴리스 후보입니다.

### Windows 설치 확인

1. 조직에서 승인·서명한 CCX 또는 UXP Developer Tool 개발 로드를 사용합니다.
2. Premiere Pro를 종료하고 조직/Adobe가 제공한 설치 흐름으로 CCX를 설치합니다.
3. Windows SmartScreen이나 조직 정책을 우회하지 말고 배포 관리자에게 확인합니다.
4. Premiere를 다시 시작해 패널, 파일 권한, Media Encoder와 업데이트 설치를 확인합니다.

### macOS 설치 확인

1. 조직에서 승인·서명한 CCX 또는 UXP Developer Tool 개발 로드를 사용합니다.
2. Premiere Pro를 종료하고 조직/Adobe가 제공한 설치 흐름으로 설치합니다.
3. Gatekeeper나 quarantine 보호를 임의로 해제하지 말고 올바른 서명/notarization 절차를 사용합니다.
4. Premiere를 다시 시작해 패널, 파일 권한, Media Encoder와 업데이트 설치를 확인합니다.

## 공개 API와 제품 제약

- Premiere 내장 Auto Reframe 명령을 직접 호출하지 않습니다. 현재 리프레임은 공개 API로 가능한 스케일·위치 계산이며 얼굴/피사체 추적이 아닙니다.
- AI가 영상 내용을 판단해 하이라이트를 고르는 기능은 없습니다. 자동 편집은 STT 시간 구간, 무음과 명시적 키워드/구두점 규칙을 사용한 검토 가능한 계획입니다.
- OpenAI STT로 SRT/텍스트를 생성할 수 있지만 Premiere의 내장 음성 분석/캡션 생성 명령을 호출하는 것은 아닙니다. 공개 UXP API에는 caption track item 생성 API가 없어 현재는 SRT 파일 저장·프로젝트 가져오기까지를 보장하고, 실제 캡션 트랙 배치는 Host gate에서 별도 검증합니다.
- recovery, final QC와 diagnostics UI는 패널 작업 흐름에 연결됐지만 실제 시퀀스 mutation 결과는 최종 Host gate에서 다시 검증해야 합니다.
- 로컬 mock 성공은 운영체제 코덱, 폰트, MOGRT, Media Encoder 프리셋과 실 렌더 품질을 보증하지 않습니다.

## Marketplace 제출 전

현재 manifest ID `com.seunghooda.shortflow.studio.direct`는 개발용입니다.

1. Adobe 배포 절차에서 정식 ID를 발급/확인하고 `public/manifest.json`의 ID를 교체합니다.
2. `package.json`과 manifest 버전을 일치시킵니다.
3. 개인정보 처리방침, 지원 URL, AI 고지, 아이콘, 권한 사유와 네트워크 도메인을 검토합니다.
4. Windows/macOS와 지원 Premiere 버전에서 [QA 체크리스트](docs/QA_CHECKLIST.md)를 완료합니다.
5. 내부 베타 build에는 source map을 포함하지 않습니다. 공개 배포에서 source map이 필요하면 별도 비공개 배포 경로를 검토합니다.
6. Adobe가 요구하는 서명·검증·심사를 별도로 수행합니다.

한 번 공개한 plugin ID를 변경하면 업데이트 경로가 끊길 수 있습니다. 이 저장소의 로컬 CCX 생성 성공을 “Marketplace-ready”로 표시하지 마세요.

## 13단계 이후 후속 기능

다음 기능은 로드맵에 기록되어 있지만 13단계 이후에만 구현을 시작합니다.

- 스마트 리프레임·피사체 추적
- 다국어 패키지 생성
- 썸네일 3종 변형 생성·내보내기
- 타임코드 검토·수정 요청·버전 스냅샷
- 플랫폼별 업로드 패키지 생성
