# 참고 플러그인(AI_Subtitler CEP) 대비 갭 분석

> **Date**: 2026-07-13 · **Project**: shortflow-studio
> **참고 원본**: `C:\Users\seung\Desktop\AI_Subtitler_v1.1\com.jamak.cep` (CEP/ExtendScript/Node, main.js 5248줄)
> **목적**: 완성된 참고 플러그인 기능을 현재 UXP 플러그인에 필요하면 이식

## 결론 요약

현재 ShortFlow Studio(UXP)는 참고 플러그인 기능의 **대부분을 이미 구현**했고, 여러 곳에서 **더 안전하고 올바른 UXP 방식**을 쓴다(인덱스 대신 `cueId`/`wordId`, 신뢰 경계 아키텍처, 범위·충돌 검사 삽입, persistent token). 참고에만 있는 것은 세 부류다.

1. **이식 금지(CEP-ism)** — CLAUDE.md가 명시적으로 금지: QE DOM(`qe.*`), `overwriteClip`, 파일명 기반 project-item 조회, 렌더러 내 Node.js, Web Audio. 다른 방식으로 대체하거나 제외.
2. **범위 밖·결정 필요** — 영상 생성/업스케일(유료 provider·비용 결정 필요, 현재 OpenAI 전용).
3. **실현 가능한 값어치 있는 추가** — 파형(파싱 기반), 고급 클립 모션, 시퀀스 오디오 자동 추출 STT.

## 기능 대조표

| 참고 기능 | 현재 상태 | 조치 |
|---|---|---|
| 3층 아키텍처 | ✅ 더 나음(신뢰 경계) | — |
| 자막 데이터 모델·편집(분할/병합/숨김/보간/undo/autosave) | ✅ cueId/wordId로 더 견고 | — |
| 단어→플레이헤드·재생 추적 | ✅ `seekToWord`/`updatePlayhead` | — |
| STT 전사(오디오→SRT/텍스트) | ✅ `runStt`/`SttResult` | ⚠️ 파일 선택식. 참고는 시퀀스에서 자동 추출(§gap-3) |
| AI 텍스트(줄바꿈/검토/번역/발췌/구성/유튜브/보강) | ✅ 전부, Host 검증 | — |
| TTS | ✅ speech-controller | — |
| 이미지 편집(보정/화질/배경제거) + **생성(text→image)** | ✅ (생성은 이번 세션) | — |
| 음악/SFX 라이브러리 + **비트 분석** | ✅ (비트는 이번 세션) | 파형 추가 여지(§gap-1) |
| MOGRT·로고·브랜드킷 삽입 | ✅ `insertMogrt`(editor.insertMogrtFromPath, **QE 아님**) | — |
| 썸네일 Canvas·레이아웃·AI | ✅ (Host Canvas 제한은 SVG fallback) | — |
| 안전영역·자동편집(무음컷/펀치인)·QC·복구·진단·권리 | ✅ | — |
| **파형 생성** | ❌ (참고는 Web Audio+Canvas) | **§gap-1** parseWavPcm+SVG로 이식 가능 |
| **고급 클립 모션**(회전·불투명·등장/퇴장·easing/spring) | ⚠️ reframe(위치·크기)+펀치만 | **§gap-2** UXP 키프레임 API로 가능(QE 아님) |
| **시퀀스 오디오 자동 추출 STT** | ⚠️ 파일 선택식 | **§gap-3** UXP 오디오 export 가능성 확인 필요 |
| **영상 생성/4K 업스케일** | ❌ | **범위 밖** — provider(Replicate 등)·비용 결정 필요 |

## 이식 금지(참고의 CEP-ism, 대체/제외)

- **QE DOM**: 트랙 생성(`addTracks`), 순차 MOGRT 크로스디졸브, `exportFramePNG`(참고에서도 미배선/휴면). UXP엔 QE 없음 → 제외. 트랙 생성이 필요하면 UXP 네이티브 API로만.
- **`overwriteClip`·파일명 조회**: 현재는 범위·충돌 검사 + persistent token(더 안전). 유지.
- **렌더러 Node.js·Web Audio**: UXP엔 없음. 네트워크는 `fetch`, 오디오 디코딩은 WAV 직접 파싱(`parseWavPcm`)으로 이미 대체.

## 실현 가능한 갭 상세

### §gap-1 파형(waveform) — 권장(자체 완결, 이번 세션 자산 재사용)
참고: `OfflineAudioContext.decodeAudioData` → peaks → Canvas + 디스크 캐시. UXP엔 Web Audio·Canvas(Host) 모두 제한. **대체**: WAV → `parseWavPcm`(이미 구현) → 다운샘플 peaks → **SVG 파형**(썸네일 SVG fallback처럼 Host에서 렌더됨). 음악/SFX 브라우저의 비트 분석과 짝. WAV 전용(압축 포맷은 안내). 규모 소~중.

### §gap-2 고급 클립 모션 — 검토(범위 확장, 중간 규모)
참고: 표준 ExtendScript 프로퍼티 API(**QE 아님**) — `setTimeVarying`/`addKey`/`setValueAtKey`, easing를 JS로 베이크(Linear/Ease/Spring/Bounce), 방향별 등장/퇴장, 위치·크기·**회전·불투명**. UXP 대응: `ComponentParam.createKeyframe`/`createAddKeyframeAction`(Keyframe.position=TickTime)·`areKeyframesSupported` 확인됨(리프레임이 이미 사용). premiere.ts `motionParams`가 이미 displayName으로 컴포넌트 탐색 — 회전/불투명 파라미터 추가 탐색 + 키프레임 베이크로 확장 가능. 내부 베타 범위엔 없던 신규 편집 기능. Host 검증 필요(활성 시퀀스+비디오 클립).

### §gap-3 시퀀스 오디오 자동 추출 STT — 검토
참고: `seq.exportAsMediaDirect(out, preset.epr, workArea)`로 16k 모노 WAV 추출 → MP3 → 전사. 현재는 사용자가 오디오 파일 선택. UXP `premierepro`의 시퀀스 export(오디오 전용 프리셋) 가능성 확인 후, 가능하면 "시퀀스에서 자막 생성" 원버튼 흐름 추가. premiere.ts에 이미 `ExportVideoOptions`/`ExportMode`/`ExportRange` 존재 — 오디오 export 경로 조사 필요.

## 참고에서 배울 견고성 패턴(부분 채택 검토)
- AI 호출 422 시 필드 점진 제거 재시도(영상/이미지 provider 다양성 대응) — 현재는 OpenAI 단일이라 우선순위 낮음.
- 오프라인 미디어 자동 relink, 콜드스타트 폴링 % 파싱 — 현재 job-queue가 유사 역할.
- 대부분 이미 현재 플러그인에 등가물 존재.
</content>
