# (폐지) 시딩 상황 파악과 진행표 갱신

**이 업무는 `influencer-seeding` 으로 합쳤다.** 260829.

`manuals/influencer-seeding/MANUAL.md` 를 읽어라. 여기 절차를 따르지 마라.

## 왜 합쳤나

`seeding-status-sync`(회신 갱신)와 `influencer-sheet-maintenance`(시트 정비)가 같은 시트의 같은 탭을
서로 모르고 만지고 있었다. 갱신 쪽은 260828 통합 전의 언어권별 탭 이름을 그대로 들고 있어서,
그대로 돌면 지금은 아무도 안 보는 `구_` 보관본에 쓴다. 오류도 안 난다.

옛 부르는 말은 전부 새 매뉴얼에 옮겼다. "시딩 상황 파악해줘" 라고 불러도 새 쪽이 나온다.

## 여기 있던 것이 어디로 갔나

| 옛것 | 지금 |
| --- | --- |
| `MANUAL.md` 절차 전체 | `manuals/influencer-seeding/MANUAL.md` |
| `checks.mjs` (안 읽음 복원 검사) | `manuals/influencer-seeding/checks.mjs` 에 계정 확인까지 붙여 합침 |
| `scripts/sheet-diff.mjs` | `manuals/influencer-seeding/scripts/sheet-diff.mjs` |

## 260827 실행 기록은 남아 있다

`work/seeding-status-sync-20260827/` 는 그대로 둔다. 그 실행이 남의 지메일을 보고 "회신 0건" 으로
끝냈고, 그 사고가 새 매뉴얼의 계정 확인 단계와 완료 검사로 들어갔다.
