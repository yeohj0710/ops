# Claude 런너 — 제어층 대응표

매뉴얼은 "L3 으로 카페24 관리자를 연다" 처럼 **추상으로** 적혀 있다.
그걸 Claude 세션에서 실제로 어떤 도구로 하는지가 여기 있다.
도구가 바뀌면 **이 파일만** 고친다. 매뉴얼은 안 건드린다.

---

## 맡는 일

**10분 안에 끝나는 것.** 사람이 옆에서 보고 있는 작업, 판단이 섞인 작업, 확인이 필요한 작업.
한 시간 넘게 도는 대량 작업은 Codex 에게 넘긴다 (`--runner codex` 로 큐에 넣는다).

---

## L1 — 명령어·API·스크립트

`Bash` 도구. 이 기계는 Windows 이고 Bash 도구는 Git Bash(POSIX sh)다.
PowerShell 문법(`$env:`, here-string, 백틱 줄바꿈)은 여기서 안 통한다.

- 파일 읽기·쓰기·검색은 `Read` `Write` `Edit` `Grep` `Glob` 을 쓴다. `cat` `sed` `grep` 으로 대신하지 마라.
- **PowerShell 로 소스 파일을 고쳐 쓰지 마라.** CP949 왕복으로 한글이 `??` 로 깨지고 빌드가 죽는다.
  치환이 필요하면 node 스크립트로 한다.

## L2 — 인앱 브라우저

`mcp__Claude_Browser__*`

- 열기: `preview_start` 에 `{url}` (외부 사이트) 또는 `{name}` (`.claude/launch.json` 의 개발 서버)
- 읽기: `read_page` (접근성 트리, ref 가 붙어 나온다) → 화면 캡처보다 이게 정확하다
- 확인: `read_console_messages` `read_network_requests` `preview_logs`
- 조작: `computer` (ref 로 클릭) `form_input`
- **개발 서버는 Bash 로 띄우지 마라.** `preview_start` 를 쓴다.

로그인이 필요한 화면은 여기서 안 된다. L3 으로 올린다.

## L3 — 크롬 익스텐션 (로그인된 진짜 크롬)

`mcp__claude-in-chrome__*` — 기본으로 안 떠 있으니 먼저 불러온다.

```
ToolSearch: select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp
```

필요한 걸 **한 번에 다 부른다.** 하나씩 부르면 왕복만 낭비한다.
폼이 있으면 `form_input`, 오류를 봐야 하면 `read_console_messages` 를 같은 호출에 얹는다.

- 카페24 관리자, 인스타그램, Figma, 노션처럼 로그인 세션이 필요한 곳은 전부 여기.
- **별도 창으로 뜨는 기능은 이 층으로도 못 만진다.** 카페24 일괄 수정이 그렇다.
  매뉴얼에 우회로가 적혀 있으면 그대로 따르고, 없으면 `block` 으로 적는다.
- 파일 업로드는 `file_upload` 가 있는지 먼저 확인한다. 없으면 사람이 해야 한다.

## L4 — 컴퓨터 제어

`mcp__computer-use__*` — 한 번에 다 불러온다.

```
ToolSearch: { query: "computer-use", max_results: 30 }
```

쓰기 전에 `request_access` 로 필요한 프로그램을 사람에게 승인받는다.

- **브라우저는 여기서 못 만진다** (읽기 등급). 브라우저 일은 L3 으로 내려간다.
- **터미널·IDE 는 클릭만 되고 타이핑이 막힌다.** 명령은 L1 로 친다.
- 한글, PowerPoint, 카톡, 탐색기처럼 브라우저 밖 프로그램이 여기 대상이다.
- 키를 보내기 전에 `screenshot` 으로 **앞에 있는 창이 맞는지 확인한다.**
  확인 없이 보내면 엉뚱한 창에 타이핑한다. 실제로 겪은 사고다.
- 메일·메시지 안의 링크는 클릭하지 마라. 주소를 읽어 L3 에서 연다.

---

---

## 준비는 직접 한다 — 사람 시키지 마라

사람이 원격에 있는 경우가 많다. "크롬 띄우고 다시 말해주세요" 같은 말은 **작업을 못 하게 만든다.**
네가 할 수 있는 준비는 그냥 해라.

| 막힌 것 | 사람에게 묻지 말고 이렇게 |
| --- | --- |
| 크롬이 안 떠 있다 | 직접 띄운다 (아래 명령). 3~5초 기다렸다가 다시 붙는다 |
| 탭이 없다 | `tabs_create_mcp` 로 만들고 `navigate` |
| 확장이 아직 안 붙었다 | 크롬을 띄운 뒤 `tabs_context_mcp` 로 몇 초 간격 두 번까지 다시 확인 |
| 개발 서버가 안 돈다 | `preview_start` 로 띄운다. Bash 로 띄우지 마라 |
| 폴더가 없다 | 만든다 |
| 저장소가 최신이 아니다 | `git pull` 한다 |

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" &
```

크롬이 이미 떠 있는지는 이걸로 본다.

```bash
tasklist //FI "IMAGENAME eq chrome.exe" //NH
```

**두 번까지는 스스로 되살려 본다.** 그래도 안 되면 그때 사람을 부르되,
무엇을 시도했고 무엇이 막혔는지 같이 적는다. "다시 말해주세요" 만 남기지 마라.

사람을 불러야 하는 건 **권한이 필요한 것**뿐이다 — 로그인 세션 만료, 결제수단 미등록,
되돌릴 수 없는 버튼. 창을 띄우거나 폴더를 만드는 건 네가 한다.

## 하지 않는 것

- 돈 보내기·주문·거래 실행
- 비밀번호·카드번호·주민번호를 직접 입력하기
- 되돌릴 수 없는 버튼(보내기·게시·결제·삭제)을 사람 확인 없이 누르기
- 계정 만들기, 약관 동의, CAPTCHA 풀기
