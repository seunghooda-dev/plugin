# ShortFlow Studio

ShortFlow Studio는 Adobe Premiere Pro용 UXP 숏폼 제작 패널입니다. 시퀀스 복제·세로 편집, 자산/레퍼런스 관리, OpenAI 기반 이미지·음성 작업, 썸네일, 자동 편집 계획, Safe Zone, 브랜드 프리셋과 내보내기 보조 기능을 한 프로젝트에서 개발하고 있습니다.

## 현재 검증 상태

이 저장소는 **Premiere Pro가 설치되지 않은 개발 환경**에서 작성되었습니다.

- 2026-07-11 기준 Node 기반 정적/mock 테스트: **818개 통과**
- TypeScript, ESLint, Vite build와 `dist` 구조 검증: 자동 명령으로 제공
- Premiere Pro, Adobe Media Encoder, UXP Developer Tool 실제 실행: **아직 검증하지 않음**
- Windows/macOS CCX 설치, Adobe 서명, Marketplace 심사: **아직 완료하지 않음**

자동 테스트는 순수 로직과 어댑터 경계를 검증하지만 Premiere 프로젝트 변경, UXP 버전 차이, 파일 권한, Media Encoder 연동과 실제 렌더 결과를 보증하지 않습니다. 배포 판단은 [QA 체크리스트](docs/QA_CHECKLIST.md)와 [요구사항 추적표](docs/REQUIREMENTS_MATRIX.md)를 함께 확인해 주세요.

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
- 이미지/영상 레퍼런스 보드와 최대 4개 이미지의 GPT Image 2 편집
- 최대 4개 레이어, 6개 레이아웃, 밝기·대비·채도·그림자·광선과 PNG 저장을 지원하는 썸네일 랩
- TTS/STT 파일 선택, 생성 결과 저장과 Premiere 오디오 삽입 흐름
- STT 결과 연계, 단어 편집/숨김/합치기, 큐 분할·병합·재배치, undo/redo, autosave와 SRT 입출력을 지원하는 자막 편집기
- STT 구간 기반 무음 컷 계획, 강조 펀치 큐/키프레임 계획, 보수적 플랫폼 Safe Zone
- 최대 20개 브랜드 키트와 폰트·색상·로고·자막·썸네일·TTS·MOGRT 기본값
- AI 작업 큐의 중복 제거, 취소, 재시도, 동시 실행 수, provider-unit 일일 한도와 승인 임계값
- clone-before-mutation 검증, 최대 50개 작업 저널, 중단 작업 복원과 검증된 복제 시퀀스 rollback을 제공하는 비파괴 복구 흐름
- 실제 시퀀스·미디어 상태와 STT/Safe Zone·사용자 입력 오디오 값을 수집하는 최종 QC, waiver, JSON/Markdown 보고서와 내보내기 차단 게이트

### 코드·자동 테스트가 준비됐지만 현재 `index.ts`에 연결되지 않은 엔진

- 진단/익명 번들/telemetry opt-in 엔진

이 두 번째 그룹은 라이브 패널 기능으로 간주하면 안 됩니다. 실제 연결, Premiere snapshot 수집, UI 승인 흐름과 호스트 테스트가 추가로 필요합니다.

## AI 이미지·음성

### 이미지 편집

- 모델은 `gpt-image-2`만 사용합니다.
- `basic`, `vivid`, `upscale`, `remove-bg`, 자유 대화형 prompt를 지원합니다.
- 입력 이미지는 최대 4개, 각 10MB 이하의 PNG/JPEG/WebP입니다.
- 패널의 이미지·음성·텍스트 AI 요청은 `https://api.openai.com/v1` 공식 API로만 전송합니다. 저장된 레거시 endpoint/provider 값도 실행 전에 공식 origin으로 정규화합니다.
- manifest 네트워크 허용 대상은 `https://api.openai.com`뿐이며 패널에서 custom endpoint/provider를 지원하지 않습니다.

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
- `npm run check`: typecheck, lint, test, build 전체 게이트
- `npm run package:ccx`: CCX 후보와 SHA-256 생성
- `npm run package:ccx:force`: 같은 버전의 서로 다른 기존 CCX를 명시적으로 교체
- `npm run clean`: build/test/release 산출물 정리

## UXP Developer Tool 개발 로드

Windows와 macOS 모두 다음 절차를 사용합니다.

1. Premiere Pro 25.6 이상과 UXP Developer Tool 2.2 이상을 설치하고 실행합니다.
2. `npm run build`를 실행합니다.
3. UXP Developer Tool의 **Add Plugin**에서 소스 manifest가 아닌 `plugin/dist/manifest.json`을 선택합니다.
4. **Load** 후 Premiere Pro의 **창 > UXP 플러그인 > ShortFlow Studio**에서 패널을 엽니다.
5. 코드를 변경하면 build 완료 후 **Reload**합니다.

이 절차는 이 저장소에서 실제 실행 검증되지 않았습니다. 메뉴명은 설치된 Premiere/UXP 버전과 언어에 따라 다를 수 있습니다.

## CCX 후보 패키징과 설치

```powershell
npm run check
npm run package:ccx
```

생성 파일:

- `release/ShortFlow-Studio-<version>.ccx`
- `release/ShortFlow-Studio-<version>.ccx.sha256.txt`

패키징 스크립트는 `dist` 내용만 ZIP/CCX 루트에 고정 순서·날짜로 넣어 재현 가능한 SHA-256을 계산합니다. 기존 같은 버전 파일과 새 내용이 다르면 서명된 파일의 우발적 덮어쓰기를 막기 위해 중단합니다.

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
- OpenAI STT로 SRT/텍스트를 생성할 수 있지만 Premiere의 내장 음성 분석/캡션 생성 명령을 호출하는 것은 아닙니다.
- recovery와 final QC는 패널 작업 흐름에 연결됐지만 Premiere 호스트 결과는 아직 검증하지 않았습니다. diagnostics 엔진은 실제 Premiere 작업 흐름에 아직 연결되지 않았습니다.
- 로컬 mock 성공은 운영체제 코덱, 폰트, MOGRT, Media Encoder 프리셋과 실 렌더 품질을 보증하지 않습니다.

## Marketplace 제출 전

현재 manifest ID `com.seunghooda.shortflow.studio.direct`는 개발용입니다.

1. Adobe 배포 절차에서 정식 ID를 발급/확인하고 `public/manifest.json`의 ID를 교체합니다.
2. `package.json`과 manifest 버전을 일치시킵니다.
3. 개인정보 처리방침, 지원 URL, AI 고지, 아이콘, 권한 사유와 네트워크 도메인을 검토합니다.
4. Windows/macOS와 지원 Premiere 버전에서 [QA 체크리스트](docs/QA_CHECKLIST.md)를 완료합니다.
5. 현재 build에 포함되는 source map의 공개 배포 정책과 민감 정보 포함 여부를 검토합니다.
6. Adobe가 요구하는 서명·검증·심사를 별도로 수행합니다.

한 번 공개한 plugin ID를 변경하면 업데이트 경로가 끊길 수 있습니다. 이 저장소의 로컬 CCX 생성 성공을 “Marketplace-ready”로 표시하지 마세요.
