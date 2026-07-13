# BGM 비트 매칭·자동 덕킹 (bgm-beat-ducking) Planning Document

> **Feature**: deferred-ai-features Phase 5 (#6) · **Project**: shortflow-studio · **Date**: 2026-07-13
> **Umbrella**: `docs/01-plan/features/deferred-ai-features.plan.md`

## 1. 범위

내부 베타 후순위 #6을 당겨 구현한다 — BGM 비트 매칭·자동 덕킹. 자체 완결(외부 provider 불필요, Web Audio·기존 자막 발화 구간 활용).

- **비트 매칭**: BGM 오디오의 비트/BPM를 검출해 비트 그리드를 제공(마커 배치·컷 정렬 근거).
- **자동 덕킹**: 발화 구간(자막 word 타이밍) 동안 BGM 볼륨을 낮추는 엔벨로프(키프레임) 계산·적용.

## 2. 아키텍처 — 순수 코어 + 주입 어댑터 (기존 패턴)

Host 가용성이 불확실한 부분(Web Audio 디코딩, 오디오 볼륨 키프레임 API)을 어댑터로 격리하고, 알고리즘은 순수 함수로 둬 단위 테스트한다.

- **순수 코어**(Host 무관, 완전 테스트): 
  - `detectBeats(samples: Float32Array, sampleRate) → { bpm, beatTimes[] }` — 에너지 플럭스 온셋 검출 + 인터-온셋 간격 히스토그램으로 BPM 추정.
  - `computeDuckingEnvelope(speechSegments, clipRange, opts) → keyframe[]` — 발화 구간에 덕(−N dB), 사이엔 복귀, fade in/out 램프.
- **주입 어댑터**(Host 게이트): 
  - 오디오 디코딩 포트: 파일 바이트 → `{ samples, sampleRate }`. UXP `AudioContext`/`OfflineAudioContext` 가용 시 사용, 없으면 기능 비활성(Canvas 제한과 동일 처리).
  - 볼륨 키프레임 적용 포트: premiere.ts가 오디오 클립 Volume>Level ComponentParam에 키프레임을 쓸 수 있으면 적용, 없으면 "덕킹 계획"만 출력(마커/리포트).

## 3. 단계

| 단계 | 내용 | 규모 | 상태 |
|---|---|---|---|
| **5a** | 비트 검출 순수 코어 `detectBeats` + 단위 테스트(합성 클릭 트랙으로 BPM 검증) | 소~중 | **완료** |
| **5b** | WAV PCM 파서 `parseWavPcm`(Web Audio 부재 대체) + 테스트(왕복·모노화·WAV→비트검출 통합) | 소~중 | **완료** |
| 5c | UI: BGM(WAV) 분석 → 파싱 → 비트검출 → BPM·비트 수 표시. 비-WAV는 미지원 안내 | 중 | **완료 · Host 통과** (음악/SFX 카드 "비트 분석" 액션, 120 BPM WAV→120.2 BPM 실측, runbook §25-j) |
| 5d | 덕킹 엔벨로프 순수 코어 `computeDuckingEnvelope` + 볼륨 키프레임 적용(premiere.ts 오디오 Volume>Level). Host 가용성 게이트, 불가 시 계획/마커 출력 | 중~대 | 대기 |

### ⚠️ Host 능력 발견 (2026-07-13, CDP 탐침 `cdt-audio-probe.mjs`)

**UXP Premiere에 Web Audio가 전혀 없다** — `AudioContext`/`OfflineAudioContext`/`webkitAudioContext` 모두 `false`, `decodeAudioData` n/a, `FileReader`도 없음(Canvas와 동일한 벽). 따라서 오디오 파일을 PCM으로 디코딩할 Host 네이티브 경로가 없다.

**대응**: WAV은 RIFF 헤더+비압축 PCM이라 바이트에서 직접 파싱 가능 → `parseWavPcm`로 Web Audio 없이 디코딩(5b). BGM/SFX가 WAV이면 Host에서 비트 검출이 동작한다. MP3/AAC/M4A 등 압축 포맷은 JS 디코더 없이는 불가하므로 **WAV만 지원**하고 나머지는 명확히 안내한다(Canvas의 "미지원" 패턴). 5d 덕킹의 볼륨 키프레임 적용은 오디오 클립 Volume>Level ComponentParam 쓰기 가용성에 달렸다 — 활성 시퀀스+오디오 클립으로 별도 탐침 필요.

각 단계 독립 게이트(`npm run check`)+커밋.

## 4. 5a 상세 (지금)

`src/audio-beats.ts` — 순수 함수.

- 입력: 모노 Float32 PCM + sampleRate. (스테레오는 호출부에서 평균해 모노화)
- 프레임(예: 1024 샘플) 단위 RMS 에너지 → 에너지 증가분(플럭스)이 지역 평균×임계 초과 지점을 온셋으로.
- 온셋 간격 히스토그램에서 우세 주기 → BPM(60~180 범위로 접기). 비트 그리드는 가장 강한 온셋에 위상 정렬.
- 출력: `{ bpm: number, beatTimes: number[] }`(초). 신뢰도 낮으면 bpm=0(불명확)로 반환.

### 검증
- 합성 신호: 120 BPM(0.5초 간격) 클릭 트랙 생성 → `bpm ≈ 120`, beatTimes 간격 ≈ 0.5초.
- 무음/노이즈 → bpm=0 또는 온셋 없음(오탐 없음).
- 경계: 빈 배열·sampleRate 0 → 안전 반환(throw 없음).
- `npm run check` green.

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| UXP에 Web Audio(decodeAudioData) 없음 | 어댑터 격리, 없으면 비활성(Canvas 패턴). 순수 코어는 무관하게 테스트 |
| UXP 오디오 볼륨 키프레임 API 부재 | 5d에서 가용성 확인, 불가 시 덕킹 계획을 마커/리포트로 출력 |
| 비트 검출 정확도 | 내부 베타는 "근사 그리드" 목표. 자동 컷이 아니라 사용자 배치 근거로 제공 |
