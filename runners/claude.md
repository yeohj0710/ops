# Claude 런너, 제어층 대응표

매뉴얼은 "L3 으로 카페24 관리자를 연다" 처럼 **추상으로** 적혀 있다.
그걸 Claude 세션에서 실제로 어떤 도구로 하는지가 여기 있다.
도구가 바뀌면 **이 파일만** 고친다. 매뉴얼은 안 건드린다.

---

## 맡는 일

**10분 안에 끝나는 것.** 사람이 옆에서 보고 있는 작업, 판단이 섞인 작업, 확인이 필요한 작업.
한 시간 넘게 도는 대량 작업은 Codex 에게 넘긴다 (`--runner codex` 로 큐에 넣는다).

---

## L1. 명령어, API, 스크립트

`Bash` 도구. 이 기계는 Windows 이고 Bash 도구는 Git Bash(POSIX sh)다.
PowerShell 문법(`$env:`, here-string, 백틱 줄바꿈)은 여기서 안 통한다.

- 파일 읽기, 쓰기, 검색은 `Read` `Write` `Edit` `Grep` `Glob` 을 쓴다. `cat` `sed` `grep` 으로 대신하지 마라.
- **PowerShell 로 소스 파일을 고쳐 쓰지 마라.** CP949 왕복으로 한글이 `??` 로 깨지고 빌드가 죽는다.
  치환이 필요하면 node 스크립트로 한다.

## L2. 인앱 브라우저

`mcp__Claude_Browser__*`

- 열기: `preview_start` 에 `{url}` (외부 사이트) 또는 `{name}` (`.claude/launch.json` 의 개발 서버)
- 읽기: `read_page` (접근성 트리, ref 가 붙어 나온다) → 화면 캡처보다 이게 정확하다
- 확인: `read_console_messages` `read_network_requests` `preview_logs`
- 조작: `computer` (ref 로 클릭) `form_input`
- **개발 서버는 Bash 로 띄우지 마라.** `preview_start` 를 쓴다.

로그인이 필요한 화면은 여기서 안 된다. L3 으로 올린다.

## L3. 크롬 익스텐션 (로그인된 진짜 크롬)

`mcp__claude-in-chrome__*` 를 쓴다. 기본으로 안 떠 있으니 먼저 불러온다.

```
ToolSearch: select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp
```

필요한 걸 **한 번에 다 부른다.** 하나씩 부르면 왕복만 낭비한다.
폼이 있으면 `form_input`, 오류를 봐야 하면 `read_console_messages` 를 같은 호출에 얹는다.

- 카페24 관리자, 인스타그램, Figma, 노션처럼 로그인 세션이 필요한 곳은 전부 여기.
- 파일 업로드는 `file_upload` 가 있는지 먼저 확인한다. 없으면 사람이 해야 한다.

### 팝업과 새 창은 안 잡힌다. 주소를 가로채서 내 탭에서 연다

**실측한 것.** 페이지가 `window.open` 으로 띄운 팝업도, `target="_blank"` 로 연 새 탭도
`tabs_context_mcp` 목록에 **안 나온다.** 그룹 밖에 생기기 때문이다. 화면에는 보이는데 만질 수가 없다.
헤매지 말고 아래대로 한다.

**1. 누르기 전에 가로채기를 심는다.**

```js
window.__opened = [];
const _open = window.open;
window.open = function(u, ...r){ if(u) window.__opened.push(String(u)); return _open.call(window, u, ...r); };
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[target="_blank"]');
  if (a && a.href) window.__opened.push(a.href);
}, true);
```

**2. 버튼을 누른다. 3. `window.__opened` 를 읽는다. 4. 그 주소를 내 탭에서 연다.**

```
navigate {tabId: <내 탭>, url: <가로챈 주소>}      기존 탭에서 이어서
tabs_create_mcp → navigate                          원래 탭을 남겨야 하면
```

이제 그 화면은 내 탭이라 `read_page`, `form_input`, 클릭이 다 된다.

**팝업이 아예 안 뜰 때도 있다.** 확장이 만든 클릭은 사용자 제스처로 안 쳐줘서 팝업 차단기에 막힌다.
위 가로채기는 차단돼도 주소를 남기니 그대로 쓰면 된다.

**같은 탭에서 열어버리는 방법**도 있다. 폼 입력만 하면 되는 팝업엔 이게 제일 간단하다.

```js
window.open = u => { if(u) location.href = u; return null };
document.querySelectorAll('a[target="_blank"]').forEach(a => a.removeAttribute('target'));
```

단 **OAuth 와 결제 인증창에는 쓰지 마라.** 그건 팝업이 부모 창에 결과를 돌려주는 구조라 흐름이 깨진다.
그런 창은 주소를 가로채 새 탭에서 열고, 끝나면 원래 탭으로 돌아간다.

**브라우저 밖 창은 여기서 못 만진다.** 윈도우 파일 선택창, 공동인증서 창, ActiveX 결제창이 그렇다.
그건 L4 로 가야 하는데 컴퓨터 제어는 브라우저가 읽기 등급이라 클릭이 막힌다. 이 경우만 사람을 부른다.

## L4. 컴퓨터 제어

`mcp__computer-use__*` 를 쓴다. 한 번에 다 불러온다.

```
ToolSearch: { query: "computer-use", max_results: 30 }
```

쓰기 전에 `request_access` 로 필요한 프로그램을 사람에게 승인받는다.

- **브라우저는 여기서 못 만진다** (읽기 등급). 브라우저 일은 L3 으로 내려간다.
- **터미널과 IDE 는 클릭만 되고 타이핑이 막힌다.** 명령은 L1 로 친다.
- 한글, PowerPoint, 카톡, 탐색기처럼 브라우저 밖 프로그램이 여기 대상이다.
- 키를 보내기 전에 `screenshot` 으로 **앞에 있는 창이 맞는지 확인한다.**
  확인 없이 보내면 엉뚱한 창에 타이핑한다. 실제로 겪은 사고다.
- 메일과 메시지 안의 링크는 클릭하지 마라. 주소를 읽어 L3 에서 연다.

---

## 끝나면 닫는다. 탭을 쌓아 두지 마라

탭과 창이 많으면 기계가 눈에 띄게 느려진다. **내가 연 것은 내가 닫는다.**

| 무엇 | 닫는 법 |
| --- | --- |
| 크롬 탭 (L3) | `mcp__claude-in-chrome__tabs_close_mcp {tabId}` |
| 인앱 브라우저 탭 (L2) | `mcp__Claude_Browser__tabs_close {tabId}`. 첫 탭은 못 닫으니 거긴 `navigate` 로 딴 데 보낸다 |
| 개발 서버 | `mcp__Claude_Browser__preview_stop {serverId}` |

- **원래 떠 있던 탭은 건드리지 마라.** 사람이 보던 것일 수 있다.
  `tabs_context_mcp` 로 처음에 목록을 받아 두면 뭐가 내 것인지 알 수 있다.
- 검증이 끝나면 바로 닫는다. 보고를 쓰기 전에 닫아라. 쓰고 나면 잊는다.
- 막혀서 그만둘 때도 닫고 나간다.
- 여러 건을 도는 작업은 **한 건 끝날 때마다** 닫는다. 마지막에 몰아서 치우려다 놓친다.

---

## 준비는 직접 한다. 사람 시키지 마라

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

사람을 불러야 하는 건 **권한이 필요한 것**뿐이다. 로그인 세션 만료, 결제수단 미등록,
되돌릴 수 없는 버튼. 창을 띄우거나 폴더를 만드는 건 네가 한다.

## 하지 않는 것

- 돈 보내기, 주문, 거래 실행
- 비밀번호, 카드번호, 주민번호를 직접 입력하기
- 되돌릴 수 없는 버튼(보내기, 게시, 결제, 삭제)을 사람 확인 없이 누르기
- 계정 만들기, 약관 동의, CAPTCHA 풀기
