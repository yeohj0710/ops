# ops — 회사 업무 관제탑

업무 하나를 **매뉴얼 한 폴더**로 적어두면, 새 세션에서 한 문장만 말하고 끝낸다.
Claude Code 와 Codex 가 같은 매뉴얼을 보고 같은 큐에서 일감을 뽑는다.

```
카톡 봐줘
```

이러면 세션이 `manuals/kakao-triage/MANUAL.md` 를 찾아 읽고, 그대로 컴퓨터를 제어해 끝낸다.

---

## 처음 세팅 (기계마다 한 번)

새 컴퓨터에서는 세션에 **"G드라이브 에이전트 폴더 보고 세팅해줘"** 라고 한 번만 말하면 된다.
`내 드라이브/에이전트/시작.md` 에 아래 명령과 설명이 들어 있다.

```bash
git clone https://github.com/yeohj0710/ops.git C:/dev/ops
node C:/dev/ops/setup.mjs
node C:/dev/ops/ops.mjs doctor
```

`setup.mjs` 가 하는 일: 이 기계 등록(프로젝트 폴더·구글 드라이브 경로 자동 탐지), 폴더 만들기,
커밋 전 검사 훅 설치, **ops 스킬을 Claude·Codex 양쪽에 설치**, 전역 설정에 두 줄짜리 포인터 넣기.

**이 말은 컴퓨터 한 대당 한 번뿐이다.** 그 뒤로 그 컴에서는 "카톡 봐줘" 처럼 짧게 시킨다.

### 드라이브는 발견층, git 은 운영층

드라이브에는 안내문 하나만 둔다(`ops.mjs sync` 가 자동으로 다시 쓴다). 매뉴얼과 일감은 저장소에 있다.

- 겹침을 `git push` 경쟁으로 판정하는데 드라이브에는 그 심판이 없다 — 같은 파일을 만지면 충돌 사본이 생긴다
- 드라이브 폴더 안에 git 저장소를 두면 동기화가 `.git` 을 건드려 깨진다
- 공개 저장소·링크 접근 요구를 드라이브로는 못 맞춘다

다른 컴에서 등록한 업무는 `manuals` · `next` · `status` 를 부를 때 6시간 간격으로 알아서 당겨온다.

매뉴얼에는 절대경로를 안 박는다. `<OPS>` `<DEV>` 로 쓰고 각 기계가 자기 값으로 읽는다.

## 쓰는 법

| 하고 싶은 것 | 명령 |
| --- | --- |
| 매뉴얼 찾기 | `node ops.mjs manuals "카톡"` |
| 새 업무 등록 | `node ops.mjs new proposal-deck --title "제안서 제작"` |
| 스킬 설명줄 갱신 | `node ops.mjs sync` |
| 일감 넣기 | `node ops.mjs add --manual kakao-triage --title "오늘 카톡 확인"` |
| 일감 뽑기 | `node ops.mjs next --runner claude` |
| 끝내기 | `node ops.mjs done <taskId> --note "…"` |
| 막혔을 때 | `node ops.mjs block <taskId> --note "…"` |
| 현황 | `node ops.mjs status` |

Codex 를 무한 루프로 돌리려면 `START.md` 의 블록을 새 세션에 붙여넣는다.

## 구조

```
AGENTS.md              Claude·Codex 공용 상시 지침 — 여기부터 읽는다
START.md               Codex 루프 시작 프롬프트
ops.mjs                일감 배급기
manuals/<업무id>/       업무 하나 = 폴더 하나
  MANUAL.md            절차서
  checks.mjs           완료 검사 (있으면 done 이 자동으로 돌린다)
runners/claude.md      Claude 가 어떤 도구로 화면을 만지는지
runners/codex.md       Codex 가 어떤 도구로 화면을 만지는지
tasks/queue|doing|done 일감 한 건 = 파일 한 개
work/<taskId>/         그 태스크의 중간 산출물
```

## 새 업무 늘리기

코드는 안 고친다. 세션에 한 문장만 말한다.

> 방금 한 거 업무로 등록해줘 / ○○ 업무로 등록해줘

세션이 `node ops.mjs new <id> --title "…"` 로 뼈대를 만들고 템플릿 칸을 채운 뒤 push 한다.
처음 하는 업무면 `manuals/_new-manual/MANUAL.md` 를 펴고 **기록 모드**로 진행한다 —
하면서 적은 기록이 그대로 매뉴얼 초안이 된다.

## 트리거는 스킬로 문다

세션에서 이 시스템을 부르는 통로는 `ops` 스킬이다.
`skill/SKILL.md` 가 원본이고 `ops.mjs sync` 가 `~/.claude/skills/ops/` 와 `~/.codex/skills/ops/`
양쪽에 설치한다. 두 도구가 같은 형식을 쓴다.

**상시 컨텍스트에는 설명 한 줄만 남는다.** 본문(절차)은 스킬이 불릴 때만 로드된다.
설명줄은 `sync` 가 `manuals/` 를 읽어 자동으로 다시 쓰므로, 업무가 늘어도 사람이 손댈 일이 없고
세션 비용은 업무 하나당 짧은 구절 하나씩만 는다.

전역 설정(`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`)에는 스킬을 가리키는 두 줄만 둔다.
지침을 여기 적으면 매 세션 전부 싣게 된다.

## 설계에서 지킨 것

- **태스크 하나 = 파일 하나.** 원장 한 파일에 몰면 두 에이전트가 무조건 충돌한다.
  파일이 갈라져 있으면 여러 세션이 동시에 돌아도 git 이 안 부딪힌다.
- **점유는 git 이 판정한다.** `queue/ → doing/` 으로 옮기고 push 한다. 밀리면 다른 걸 집는다.
  락 서버가 없다.
- **화면은 기계당 하나.** L3·L4 태스크는 배급기가 한 번에 하나만 내준다.
- **매뉴얼에 도구 이름을 안 쓴다.** 도구는 `runners/*.md` 에만 있다. 도구가 바뀌면 거기만 고친다.
- **매뉴얼에 좌표를 안 쓴다.** 화면 배율이 바뀌면 다른 데를 누른다.

## 공개 저장소다

커밋하는 건 전부 남이 볼 수 있고 지워도 기록에 남는다.
`scripts/scan-secrets.mjs` 가 커밋 전에 API 키·주민번호·계좌·연락처·신분증 파일을 막는다.
검사가 틀렸으면 `OPS_SCAN_OK=1 git commit ...` 으로 사람이 통과시킨다.
