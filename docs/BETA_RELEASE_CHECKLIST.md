# ShortFlow Studio 내부 베타 체크포인트 체크리스트

이 문서는 최종 내부 베타 후보를 만들기 직전에 사용하는 짧은 승인표입니다. 상세 검증 절차는 `QA_CHECKLIST.md`와 `HOST_BETA_RUNBOOK.md`를 원본으로 삼고, 이 파일은 “지금 커밋해도 되는가”만 빠르게 판단합니다.

## 1. 커밋 전 차단 조건

- [ ] 작업 트리에 의도하지 않은 변경이 없습니다.
- [ ] 중간 커밋 없이 하나의 체크포인트 커밋으로 묶을 변경만 남았습니다.
- [ ] `npm run typecheck`가 통과했습니다.
- [ ] `npm run lint`가 통과했습니다.
- [ ] `npm test`가 통과했습니다.
- [ ] `npm run build`가 통과했고 `dist/` 검증이 끝났습니다.
- [ ] 위 자동 게이트가 통과한 소스를 하나의 검증된 체크포인트 커밋으로 만들었습니다.
- [ ] 커밋 후 작업 트리가 clean 상태입니다.
- [ ] clean 커밋에서 `npm run beta:evidence:verified`를 실행해 CCX, SHA-256, Git commit/tree가 묶인 증거 파일을 생성했습니다.

## 2. 실제 Premiere Host 필수 확인

- [ ] 최신 `dist/manifest.json`을 UXP Developer Tool에서 다시 로드했습니다.
- [ ] Premiere 메뉴에서 `ShortFlow Studio` 패널을 열고 닫은 뒤 다시 열 수 있습니다.
- [ ] 테스트 전용 프로젝트와 테스트 전용 시퀀스만 사용했습니다.
- [ ] 프로젝트 없음, 활성 시퀀스 없음, 활성 시퀀스 있음 상태가 모두 안전하게 표시됩니다.
- [ ] 플레이헤드, In/Out, 선택 TrackItem 상태가 패널 표시와 일치합니다.
- [ ] SRT 파일 가져오기와 자막 편집기 표시가 동작합니다.
- [ ] TTS 오디오 파일 저장, 프로젝트 가져오기, 지정 오디오 트랙 삽입을 확인했습니다.
- [ ] 음악/SFX 폴더 동기화, 미리듣기, 순서 이동, 타임라인 삽입을 확인했습니다.
- [ ] 자동 컷·펀치인은 원본을 보존하고 복제 시퀀스에서만 marker/keyframe을 적용합니다.
- [ ] Safe Zone BMP overlay는 export 전에 제거 경고 또는 차단으로 잡힙니다.
- [ ] 썸네일은 Host Canvas 제한을 고려해 PNG/JPG 또는 SVG fallback 저장 경로를 확인했습니다.
- [ ] 복구 저널 영속성, 진단 JSON, 최종 QC JSON/Markdown 저장을 실제 UXP 파일 권한으로 확인했습니다.
- [ ] 복제본 제거 rollback은 폐기 가능한 프로젝트에서 명시적 확인 후 별도 검증했습니다.

## 3. 최종 QC와 권리 관리

- [ ] 최종 QC의 `report.blocking === false`입니다. 모든 blocking code와 수용한 비 hard-block waiver를 기록했습니다.
- [ ] 최종 QC hard block은 waiver로 통과시키지 않았습니다.
- [ ] 일반 waiver는 5자 이상의 사유, 코드, 시각이 기록됩니다.
- [ ] 출력 파일명과 출력 폴더는 절대 경로·예약어·상위 경로 이동·URL scheme을 피합니다.
- [ ] 음악·이미지·영상·AI 산출물의 출처, 라이선스, 상업 사용 여부, 만료일, 출처 표기를 기록했습니다.
- [ ] 상업 사용 불가 또는 만료 에셋은 내보내기 차단으로 남습니다.
- [ ] 미확인·누락 권리 정보는 경고로 표시되고 사용자가 검토했습니다.
- [ ] 권리 리포트가 최종 QC JSON/Markdown에 포함됩니다.

## 4. 민감정보와 로컬 파일 경로

- [ ] 진단 JSON에는 API key, Authorization header, access/refresh token, 원고, prompt, 로컬 경로, 미디어명이 남지 않습니다.
- [ ] 최종 QC와 권리 리포트는 로컬 내부용 산출물로 취급하며 외부 공유 전 sequence name, output name, asset name, attribution, asset id를 검토합니다.
- [ ] 복구 저널 UI에는 테스트 프로젝트명과 테스트 미디어명만 표시됩니다.
- [ ] 자동 텔레메트리 서버 전송은 기본 꺼짐이며 내부 베타에서는 사용하지 않습니다.
- [ ] API key가 필요한 live TTS/STT는 사용자 승인과 테스트 key가 있을 때만 실행했습니다.

## 5. 산출물 고정

- [ ] `release/ShortFlow-Studio-*.ccx`가 최신 소스에서 생성됐습니다.
- [ ] `.sha256.txt` 값이 실제 CCX와 일치합니다.
- [ ] CCX 안에 `src/`, `tests/`, `node_modules/`, `.git/`, `.env`, source map, credential 파일이 없습니다.
- [ ] `beta-evidence/` 증거 파일에 최신 commit, git status, manifest, CCX SHA-256이 기록됐습니다.
- [ ] README, ROADMAP, REQUIREMENTS_MATRIX, QA_CHECKLIST의 제한사항과 실제 상태가 서로 모순되지 않습니다.
- [ ] 체크포인트 커밋 메시지는 내부 베타 검증 범위와 남은 Host 제한을 함께 설명합니다.
- [ ] GitHub push는 `typecheck`·`lint`·`test`·`build`가 통과한 하나의 응집된 작업 묶음마다 수행하고, 로컬·원격 commit ID 일치를 확인합니다.
