# Codex 초기화 조짐 확인

- **부르는 말**: Codex 초기화 조짐 확인해줘, Codex 리셋 조짐 봐줘, Tibo 리셋 신호 확인해줘, 초기화 곧 할 것 같아, Codex 리셋 올지 봐줘
- **미리 허가**: 없음. 공개 자료를 읽고 현재 판정을 대화로 보고한다
- **런너**: either
- **제어층**: L1 → L2 → L3
- **한 번에 걸리는 시간**: 3~8분

---

## 무엇을 만드는 업무인가

Tibo의 공개 X 계정 `@thsottiaux`, 직접 X 자료를 보존하는 공개 이벤트 API, OpenAI 공식 문서를 확인해
Codex 추가 초기화가 이미 끝났는지, 일정이 확정됐는지, 강한 언지만 있는지 판정한다.
결과는 **한 줄 결론, 근거 점수, 원문과 시각, 사용자 행동** 순서로 대화에 보고한다.

이 업무는 확률을 맞히는 업무가 아니다. `근거 점수`는 공개 신호의 강도이며 실제 발생 확률이 아니다.

## 실행 계약

사용자가 이 업무를 호출하면 이 매뉴얼의 절차와 완료 검사를 한 번에 실행한다.
공개 게시물을 읽기만 하며 팔로우, 좋아요, 답글, 게시, 메시지 전송은 하지 않는다.

## 준비물

- 인터넷 연결
- L1 공개 HTTP. 막히면 L2, X 로그인 세션이 꼭 필요할 때만 L3
- 개인 계정 적용 여부까지 물으면 Codex `Settings → Usage` 화면. 공개 공지와 개인 계정 반영은 따로 판정한다

## 기준 자료

우선순위가 높은 순서다.

1. Tibo X 원문: `https://x.com/thsottiaux`
2. Tibo 원문을 Direct X API로 가져와 원문 URL·시각·검증 상태를 남기는 공개 자료:
   `https://tibo.modelyard.dev/api/events`
3. OpenAI 공식 문서. hard reset과 banked reset을 구분할 때 사용:
   `https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work`
4. 발견·교차 확인용 보조 자료: `https://tibo.modelyard.dev/reset-history/`,
   `https://codex-reset.com/tibo`, `https://t.me/s/codexreset`

보조 자료만으로 확정 판정을 내리지 않는다. 원문 URL, `source_quality=DIRECT`,
`verification_status=DIRECT_VERIFIED` 중 확인되는 것을 같이 적는다.

## 실데이터에서 확인한 패턴

2026-08-31에 공개 API의 44개 이벤트를 대조했다. 이 중 reset 계열 분류는 35개였다.
아래 표는 원문과 완료 시각을 함께 확인할 수 있는 최근 사례만 추린 것이다.

| 선행 신호(UTC) | 완료 확인(UTC) | 관찰된 간격 | 판정에 쓰는 표현 |
| --- | --- | ---: | --- |
| 8/21 11:43 | 8/22 00:50 | 13시간 7분 | 20M, celebration, BANKED reset today |
| 8/23 06:29 | 8/24 00:46 | 18시간 18분 | reset tomorrow, around 14:00 PST |
| 8/27 06:31 | 8/27 16:35 | 10시간 4분 | find the reset button tomorrow |
| 8/29 05:38 | 8/29 20:43 | 15시간 5분 | milestone to celebrate tomorrow, hold on |
| 8/29 21:23 | 8/31 02:29 | 29시간 6분 | celebration moved to tomorrow, button pressed |
| 8/30 19:24 | 8/31 02:29 | 7시간 5분 | reset will land at 6pm PST |

관찰 표본에서는 **명시적 일정 4건이 모두 7~30시간 안에 완료 확인으로 이어졌고**,
은유적 사전 언지 2건도 10~15시간 안에 완료 확인으로 이어졌다. 표본이 작고 여러 원인이 겹친다.
고정 주기나 미래 보장으로 해석하지 않는다.

반복된 원인은 두 갈래였다.

- 활성 사용자 이정표와 축하: 9M, 15M, 20M, 25M 등
- 예상보다 빠른 사용량 소진 조사와 수정 배포: 캐시 적중률, 이미지가 긴 세션에 남는 문제,
  백그라운드 작업·재시도·도구 루프 등

## 판정 등급

분류는 **이미 완료된 일부터 먼저 제거한 뒤** 남은 미래 신호에 적용한다.

| 등급 | 근거 점수 | 조건 | 보고 문구 |
| --- | ---: | --- | --- |
| 완료 | 별도 | `has been reset`, `reset propagated`, `brand new usage`, `reset has landed` | 이미 초기화됨 |
| 확정 예정 | 90~100 | reset 대상과 미래 시각·기한을 직접 말함 | 초기화 예정이 확인됨 |
| 강한 조짐 | 70~89 | `milestone/celebrate tomorrow`, `hold on`, `reset button tomorrow`, `little surprise tomorrow` | 강한 언지가 있음 |
| 보조 조짐 | 35~69 | 사용량 이상 조사·수정 배포와 보상 언급. 미래 초기화 표현은 없음 | 가능성은 있으나 직접 언지는 없음 |
| 새 조짐 없음 | 0~34 | 최근 완료 뒤 새로운 미래 신호가 없음 | 현재 공개 근거로는 새 조짐 없음 |

`RESET_PLANNED` 같은 제3자 분류보다 원문 시제를 우선한다. 실제로 2026-08-31 이벤트 하나는
`RESET_PLANNED`로 분류됐지만 원문이 `we have now reset`이라 완료였다.

hard reset과 banked reset도 섞지 않는다.

- hard/global reset: 대상 사용량 창을 즉시 새로 채울 수 있고 주간 초기화 날짜가 바뀔 수 있다
- banked reset: 계정에 저장되는 1회권. 사용자가 적용할 때 5시간·주간 창이 새로 설정되며 만료될 수 있다

## 절차

1. **공개 이벤트를 수집하고 1차 판정한다 (L1)**

   ```text
   node "<OPS>/manuals/codex-reset-signal-check/scripts/check-signals.mjs"
   ```

   스크립트는 공개 API를 끝까지 페이지 순회하고 `source_text`의 시제를 다시 읽는다.
   최신 완료보다 뒤에 나온 미래 신호만 현재 조짐으로 인정한다.

2. **최신성·원문을 확인한다 (L1)**

   - `데이터 최신성`이 2시간 이내인지 확인한다
   - 판정 근거의 X 원문 URL, 게시 시각, 직접 검증 상태를 확인한다
   - 최신성이 2시간을 넘거나 API가 실패하면 공개 검색으로 최근 72시간의
     `site:x.com/thsottiaux Codex reset usage milestone`와 Tibo 답글을 찾는다
   - X가 L1에 403을 돌려도 게시물이 없다는 뜻이 아니다. L2로 원문을 열고, 로그인된 세션이 꼭 필요할 때만 L3를 쓴다

3. **공식 문서로 종류를 구분한다 (L1)**

   `banked`, `full`, `global`, `automatic` 표현을 공식 문서 정의와 대조한다.
   대상 요금제, 만료, 적용 시각이 원문에 없으면 모른다고 적고 추측하지 않는다.

4. **개인 계정 상태는 별도 확인한다 (L2)**

   사용자가 “내 계정에도 들어왔나”까지 물었을 때만 Codex `Settings → Usage`를 확인한다.
   공개 공지가 있어도 계정별 반영이 늦거나 대상이 다를 수 있다. 화면에서 사용 가능량,
   다음 초기화 시각, `reset available` 표시를 읽는다. banked reset은 사용하지 않는다.

5. **짧게 보고한다**

   ```text
   결론: 강한 조짐 있음 — Tibo가 “내일 축하할 이정표”와 “Codex를 아껴두라”고 직접 언급.
   근거 점수: 80/100 (발생 확률이 아니라 공개 신호 강도)
   시각: 2026-08-29 14:38 KST · 원문: <URL>
   구분: hard reset 언지로 보이나 대상·정확한 시각은 미확정.
   권장: 오늘 급하지 않은 대량 작업은 12~24시간 보류. 확정 공지가 나오면 다시 확인.
   ```

   이미 완료됐다면 “조짐 있음”이라고 하지 말고 `최근 초기화 완료, 그 뒤 새 언지 없음`이라고 쓴다.

## 산출물

- 기본: 대화 보고만 남긴다
- 큐 업무나 재현 자료가 필요할 때:

  ```text
  node "<OPS>/manuals/codex-reset-signal-check/scripts/check-signals.mjs" --out "<OPS>/work/<taskId>/codex-reset-signal-report.md"
  ```

## 완료 검사

- [ ] 최신 완료와 그 뒤의 미래 신호를 시간순으로 분리했다
- [ ] `이미 완료`, `확정 예정`, `강한 조짐`, `새 조짐 없음` 중 하나로 결론을 냈다
- [ ] 근거 점수를 확률처럼 쓰지 않았다
- [ ] 원문 URL, 게시 시각, 데이터 최신성을 적었다
- [ ] hard reset과 banked reset을 구분했다
- [ ] 개인 계정 반영 여부를 공개 공지로 단정하지 않았다

## 알려진 함정

- X 원문이 L1에서 403 → X 차단일 뿐 신호 부재가 아니다 → Direct X API 자료를 보고 L2로 원문을 교차 확인한다
- 공개 API의 `category`가 원문 시제와 충돌 → 분류 오류가 실제로 있었다 → `source_text`의 `now/has been/will/tomorrow`를 우선한다
- 완료 게시물 뒤의 `see you soon` 같은 농담 → 구체적 미래 시각·이정표가 없다 → 새 조짐 점수를 올리지 않는다
- tracker의 reset 시각 → 계정 UI 변화를 관측한 보조 자료일 수 있다 → Tibo 원문과 개인 `Settings → Usage`를 따로 적는다
- 주말·요일·최근 평균 간격 → 공개 약속이 아니다 → 단독 근거로 점수를 주지 않는다
- banked reset 발표 → 자동 초기화가 아니다 → 사용 가능한 1회권과 즉시 hard reset을 구분한다
- 최근 완료 직후 `RESET_PLANNED` 중복 이벤트 → 이미 일어난 일을 미래 예측으로 잘못 셀 수 있다 → 최신 완료 뒤의 미래형 원문만 남긴다

## 사람에게 물어야 하는 지점

- 없음. 공개 자료 확인은 읽기 전용이다
- banked reset 사용, 계정 변경, 구매는 이 업무 범위가 아니다
