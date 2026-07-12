# 변경 기록

이 문서는 사용자와 배포 담당자에게 영향을 주는 변경 사항을 기록합니다. 버전은 [Semantic Versioning](https://semver.org/lang/ko/) 원칙을 따릅니다.

## [1.0.0] - 2026-07-11

### 개발 범위

- 현재 목표를 판매·상용화 버전이 아닌 Premiere 내부 베타로 재정의
- 실제 편집 시간을 줄이는 자막/TTS/음악·SFX/수동 썸네일/Safe Zone/기본 자동 편집/로컬 안정성/에셋 권리 관리만 현재 게이트에 포함
- 결제·SaaS·자동 텔레메트리 서버·고급 AI 생성/수정·비트 매칭·다국어·스마트 리프레임·업로드 자동화를 후순위로 이동

### 추가

- Premiere Pro 25.6+ UXP 패널과 manifest v5
- 활성 시퀀스 상태, 플랫폼 프로필, 기본 QC, 비파괴 시퀀스 복제와 세로 리프레임
- 인/아웃·선택·재생헤드·전체 시퀀스와 스토리 마커 기반 작업 범위
- MOGRT 삽입, Media Encoder 프리셋 내보내기와 현재 프레임 커버 저장
- persistent token 기반 자산 라이브러리와 이미지/영상 레퍼런스 보드, 프롬프트 메모·태그·출처 기록
- 음악·효과음 라이브러리의 사용자 순서 저장, 카드 드래그 정렬, 패널 내 오디오 미리듣기
- 자산 패널에서 음악·효과음의 출처·라이선스·상업 사용 여부·만료일·출처 표기를 저장하고 최종 QC 권리 리포트에 반영
- 썸네일 레이아웃/Canvas/PNG/JPG 수동 편집 워크플로. GPT Image 2 편집 코드는 유지하지만 내부 베타 UI에서는 숨김·비활성
- OpenAI TTS, STT, 화자 구분 transcript와 SRT/텍스트 파일 관리
- 자막 문서 편집·검증·SRT·autosave·undo/redo 엔진 및 컨트롤러, SRT 가져오기 입력 상한
- 손상 자막 저장본의 엄격한 스키마·정렬·32Mi 문자 상한 검증, 비동기 AI/프로젝트 전환 경합 차단과 대용량 재생 추적 최적화
- STT 기반 무음 컷/펀치 계획, 실제 발화 보호, transcript 무효화·중복 실행 차단, 합산 500개 host 상한과 실패 clone 정리
- 브랜드 키트 프리셋과 파일 token 검증
- AI 작업 큐, deterministic dedupe, 취소/재시도, 메타 캐시와 provider-unit 예산
- clone-before-mutation 복구 저널, 외부 부작용 rollback과 interrupted 복구 엔진
- 자막·Safe Zone revision·오디오·누락 미디어·출력 경로를 검사하는 최종 QC 게이트
- 음악·이미지·AI 에셋의 출처·라이선스·상업 사용·만료일·출처 표기를 저장하고 JSON/Markdown 권리 리포트와 최종 QC 차단/경고로 연결하는 에셋 권리 관리 코어
- 사용자 실행 로컬 진단 번들, API capability guard와 민감정보 redaction. 자동 telemetry 서버는 내부 베타 후순위
- TypeScript, ESLint, Node mock/순수 테스트와 Vite 배포 검증
- `dist` 루트의 재현 가능한 CCX 후보 패키징, SHA-256, 심볼릭 링크/민감 파일/HTTPS 도메인/source map 검사, 릴리스 산출물 재검증과 안전한 덮어쓰기 정책
- manifest `launchProcess` 권한을 `file` scheme과 내부 베타 미디어 확장자 allowlist로 제한하는 배포 산출물 검증
- Premiere 26.3 `create*Action()` 규칙에 맞춰 Action 생성을 `lockedAccess()` 트랜잭션 내부 factory로 지연
- Canvas 없이 Safe Zone 가이드를 생성하는 BMP 오버레이 경로

### 보안·개인정보

- OpenAI API key를 UXP secureStorage에 저장하고 오류/보고서에서 key·Authorization을 마스킹
- 이미지·음성·텍스트 AI 전송 전 명시적 사용자 동의 게이트
- OpenAI 공식 API origin 전용 정책, 레거시 endpoint/provider 정규화와 경로 traversal 방어
- telemetry 관련 코드는 기본 opt-out, allowlist payload, bounded retry/TTL로 제한하며 현재 패널은 자동 전송 provider를 초기화하지 않음
- AI 이미지 4개·각 10MB, STT 25MB, TTS 4,096자 등 입력 상한

### 검증 상태

- 범위 재정의 전 `npm test`: 864/864 통과
- 2026-07-12 Mock 기준선 `npm run check`: typecheck·전체 lint·build·dist 검증·993/993 test 통과
- 이전 로컬 CCX 후보와 SHA-256은 `npm run beta:evidence:verified`로 생성·검증 완료. SHA-256: `dadc2dd405a8facceca761175d63360b140b0e8d30fe783d167d3c8cedc50df8`. 이후 소스 변경분은 최종 Host gate 후 재패키징 필요.
- Premiere Pro/UXP Developer Tool 실제 개발 로드: 패널 표시, UDT watch/reload, 빈 프로젝트 안전 처리, 테스트 MP4 import, 활성 시퀀스 기본 QC, 최신 dist 탭 전환, 마커 탭 표시, Safe Zone overlay, SRT 파일 import, 음악/SFX WAV A1 삽입, TrackItem 선택 감지까지 제한 통과
- Premiere Pro 26.3 Host에서 `sequence.getSelection()`이 빈 배열을 반환해도 개별 `TrackItem.getIsSelected()` fallback으로 선택 상태를 감지하도록 보강하고 실제 패널 UI에서 `타임라인 4개 선택 · 00:06` 표시를 확인
- TTS live/API 생성·삽입, 자동 컷 복제 시퀀스 적용과 Media Encoder Host 테스트: 최종 승인 전 재검증 필요
- Windows/macOS CCX 설치, Adobe 서명, notarization, Marketplace 심사: 미실시

### 알려진 제약

- 내장 Auto Reframe이나 AI 하이라이트 선택을 호출하지 않으며 스케일/위치 및 STT 규칙 기반 계획을 사용합니다.
- 자막 컨트롤러, 복구, 최종 QC와 진단 UI는 패널 초기화 흐름에 연결됐지만 실제 Premiere 시퀀스 mutation 결과는 최종 Host gate에서 재확인해야 합니다.
- Premiere Pro 26.3 UXP Canvas는 썸네일 PNG/JPG export에 필요한 일부 Canvas API가 부족해 Host에서는 PNG/JPG 버튼을 비활성화하고 이미지 data URL을 내장하는 SVG fallback 저장 경로를 사용합니다.
- 공개 UXP API에는 caption track item 생성 API가 없어 SRT는 파일 저장·프로젝트 가져오기까지 보장하고, 실제 캡션 트랙 배치는 Host gate에서 실험·문서화해야 합니다.
- 로컬 CCX는 서명 전 후보이며 Marketplace 배포 가능 상태를 의미하지 않습니다.
