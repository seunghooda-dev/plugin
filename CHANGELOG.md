# 변경 기록

이 문서는 사용자와 배포 담당자에게 영향을 주는 변경 사항을 기록합니다. 버전은 [Semantic Versioning](https://semver.org/lang/ko/) 원칙을 따릅니다.

## [1.0.0] - 2026-07-11

### 추가

- Premiere Pro 25.6+ UXP 패널과 manifest v5
- 활성 시퀀스 상태, 플랫폼 프로필, 기본 QC, 비파괴 시퀀스 복제와 세로 리프레임
- 인/아웃·선택·재생헤드·전체 시퀀스와 스토리 마커 기반 작업 범위
- MOGRT 삽입, Media Encoder 프리셋 내보내기와 현재 프레임 커버 저장
- persistent token 기반 자산 라이브러리와 이미지/영상 레퍼런스 보드
- GPT Image 2 다중 이미지 편집과 썸네일 레이아웃/Canvas/PNG 워크플로
- OpenAI TTS, STT, 화자 구분 transcript와 SRT/텍스트 파일 관리
- 자막 문서 편집·검증·SRT·autosave·undo/redo 엔진 및 컨트롤러
- STT 기반 무음 컷/펀치 계획과 YouTube Shorts/Reels/TikTok Safe Zone
- 브랜드 키트 프리셋과 파일 token 검증
- AI 작업 큐, deterministic dedupe, 취소/재시도, 메타 캐시와 provider-unit 예산
- clone-before-mutation 복구 저널, 외부 부작용 rollback과 interrupted 복구 엔진
- 자막·Safe Zone·오디오·누락 미디어·출력 경로를 검사하는 최종 QC 게이트
- 익명 진단 번들, API capability guard와 명시적 opt-in telemetry 엔진
- TypeScript, ESLint, 821개 Node mock/순수 테스트와 Vite 배포 검증
- `dist` 루트의 재현 가능한 CCX 후보 패키징, SHA-256, 심볼릭 링크/민감 파일/HTTPS 도메인 검사와 안전한 덮어쓰기 정책

### 보안·개인정보

- OpenAI API key를 UXP secureStorage에 저장하고 오류/보고서에서 key·Authorization을 마스킹
- OpenAI 공식 API origin 전용 정책, 레거시 endpoint/provider 정규화와 경로 traversal 방어
- telemetry 기본 opt-out, allowlist payload, bounded retry/TTL
- AI 이미지 4개·각 10MB, STT 25MB, TTS 4,096자 등 입력 상한

### 검증 상태

- 2026-07-11 개발 환경에서 `npm test`: 821/821 통과
- Premiere Pro, Media Encoder, UXP Developer Tool 실제 호스트 테스트: 미실시
- Windows/macOS CCX 설치, Adobe 서명, notarization, Marketplace 심사: 미실시

### 알려진 제약

- 내장 Auto Reframe이나 AI 하이라이트 선택을 호출하지 않으며 스케일/위치 및 STT 규칙 기반 계획을 사용합니다.
- 자막 컨트롤러, 복구, 최종 QC와 진단 UI는 패널 초기화 흐름에 연결됐지만 Premiere 호스트에서 미검증입니다.
- 로컬 CCX는 서명 전 후보이며 Marketplace 배포 가능 상태를 의미하지 않습니다.
