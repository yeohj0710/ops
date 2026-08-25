# 인스타 계정 지표 실측

- **부르는 말**: 인스타 지표 뽑아줘, 릴스 조회수 측정해줘, 인플루언서 지표 실측, 미측정 채워줘, 팔로워 조회수 채워줘, 후보 계정 재측정
- **미리 허가**: 인스타 지표 읽기와 대상 시트 쓰기
- **런너**: codex (계정이 수백 개라 길게 돈다. 수십 개면 claude 도 된다)
- **제어층**: L3 (로그인된 크롬의 instagram.com 탭 안에서 fetch) → 시트 쓰기도 L3
- **한 번에 걸리는 시간**: 계정 100개당 약 10분 (요청 2초 간격 + 100개마다 5분 휴식)

---

## 무엇을 만드는 업무인가

인플루언서 후보 시트의 빈 지표를 실제 값으로 채운다. 끝나면 대상 탭의 모든 행에
**팔로워, 릴스 중앙 조회수, 최근 게시일, 게시물 수, 계정 상태**가 들어 있고
`미측정`, `미확인` 같은 자리표시자가 남아 있지 않다.

**릴스 중앙 조회수가 이 업무의 목적이다.** 단가와 성과의 실질 기준이 팔로워가 아니라 이 값이다.

## 준비물

- **인스타 로그인된 크롬.** 회사 계정 `@wellnessbox_global_official` 이 기본이다.
  로그인이 풀렸으면 `AGENTS.md` 의 "로그인 화면은 멈추는 자리가 아니다" 를 따른다.
- **대상 시트와 탭 이름.** 안 정해주면 미모미 진행표의 인스타 탭 세 개를 전부 한다.
- 핸들이 들어 있는 열. 열 번호는 매번 읽어서 확인한다(아래 함정 참고).

| 기본 대상 | 값 |
| --- | --- |
| 미모미 진행표 시트 | `1heUo8C09kEHMQo7qOTYC5bMOCSMTHCvb-m7O3tm2BOE` |
| 그 시트의 인스타 탭 | 중국 진행표, 직접 탐색 후보, 일본 진행표 |
| 통합 컨택 리스트 시트 | `1tC4xdmK_Q4kF4PQfPyoRDC_gLTutfw6_7sBRHkJdsCc` |

## 절차

1. **대상 탭의 2행 헤더를 A부터 끝까지 읽는다 (L1 로 시도, 막히면 L3)**
   L1 은 gviz 로 읽으면 빠르다. **열 번호를 기억으로 쓰지 마라.** 다른 세션이 열을 넣고 뺀다.
   핸들 열, 팔로워 열, 조회수 열, 상태 열이 각각 어디인지 이름으로 찾아 적어둔다.

2. **instagram.com 탭을 하나 연다 (L3)**
   아무 페이지나 좋다. 프로필을 열 필요가 없다.
   `이게 보이면 성공`: 로그인 상태의 피드나 프로필이 뜬다. 로그인 화면이면 준비물로 돌아간다.

3. **그 탭 안에서 지표를 받는다 (L3)**
   **화면을 읽지 않는다. 같은 출처 fetch 로 내부 API 를 부른다.**
   격자가 렌더될 때까지 기다리는 방식은 실패한다(함정 첫 줄).

   ```js
   const H = {'x-ig-app-id':'936619743392459'};
   async function grab(name){
     const out = {name};
     const r = await fetch('/api/v1/users/web_profile_info/?username='+encodeURIComponent(name),
                           {headers:H, credentials:'include'});
     if(!r.ok){ out.status = r.status===404 ? '계정없음' : ('오류'+r.status); return out; }
     const u = (await r.json()).data.user;
     out.id        = u.id;
     out.followers = u.edge_followed_by.count;
     out.posts     = u.edge_owner_to_timeline_media?.count ?? null;
     out.bio       = u.biography || '';
     out.link      = u.external_url || '';
     if(u.is_private){ out.status='비공개'; return out; }
     const f = await fetch('/api/v1/feed/user/'+u.id+'/?count=33',
                           {headers:H, credentials:'include'});
     if(!f.ok){ out.status='피드오류'+f.status; return out; }
     const items = (await f.json()).items || [];
     const byDate = [...items].sort((a,b)=>b.taken_at-a.taken_at);
     let reels = byDate.filter(it=>it.product_type==='clips');
     if(!reels.length) reels = byDate.filter(it=>it.play_count!=null);
     const v = reels.slice(0,12).map(it=>it.play_count).filter(n=>n!=null).sort((a,b)=>a-b);
     out.reelCount  = v.length;
     out.reelMedian = v.length ? (v.length%2 ? v[(v.length-1)/2]
                                : Math.round((v[v.length/2-1]+v[v.length/2])/2)) : null;
     out.lastPost   = items.length
         ? new Date(Math.max(...items.map(i=>i.taken_at))*1000).toISOString().slice(0,10) : null;
     out.status     = v.length ? '측정완료' : '릴스없음';
     return out;
   }
   const res = [];
   for(const n of NAMES){ res.push(await grab(n)); await new Promise(s=>setTimeout(s,2000)); }
   res
   ```

   `이게 보이면 성공`: 첫 계정에서 `followers` 에 숫자가 오고 `status` 가 `측정완료` 다.
   전부 `오류401` 이면 로그인이 안 된 것이고, 전부 `오류429` 면 이미 제한이 걸린 것이다.

4. **한 건 얻을 때마다 시트에 적는다 (L3)**
   몰아서 쓰지 마라. 중간에 끊기면 다 날아간다.

   | 시트 항목 | 넣을 값 |
   | --- | --- |
   | 팔로워 | `followers` (콤마 없이 숫자) |
   | 릴스 중앙 조회수 | `reelMedian`. 없으면 `status` 문구를 적는다 |
   | 최근 게시일 | `lastPost` (YYYY-MM-DD) |
   | 게시물 수 | `posts` |
   | 계정 상태 | `status` (측정완료 / 비공개 / 계정없음 / 릴스없음 / 오류NNN) |
   | 비고 | `reelCount` 가 9 미만이면 "릴스 N편 기준" |

   **이미 적혀 있는 `미측정`, `미확인`, `비공개` 는 전부 덮어쓴다.** 지난 런이 격자를 못 열어서
   못 잰 것이지 실제 값이 아니다. 다만 **사람이 손으로 넣은 열은 건드리지 마라**
   (진행 상태, 합의 단가, 협상 메모, 확정, 방문 예정일).

5. **분포를 내서 보고한다 (L1)**
   탭별 처리 행 수, 측정완료 / 비공개 / 계정없음 / 릴스없음 수,
   그리고 릴스 중앙 조회수의 최소, 중앙값, 최대. 단가 구간을 다시 정하는 근거다.

## 산출물

- 대상 탭의 지표 열이 실측값으로 채워진 상태
- 채팅에 분포 요약 (위 5번)

## 완료 검사

- [ ] (기계) 대상 탭에 `미측정`, `미확인` 문자열이 0건이다
- [ ] (기계) 팔로워 열이 전부 숫자이거나 상태 문구다. 빈칸이 없다
- [ ] (사람) 릴스 중앙 조회수 분포가 그럴듯한지 본다. 전부 0 이거나 전부 같으면 잘못 뽑은 것이다
- [ ] (사람) 비공개로 남은 계정을 몇 개 직접 열어 정말 비공개인지 확인한다

## 알려진 함정

- **릴스 격자가 안 열려서 3차 조사 런의 상위 50명이 통째로 미측정으로 끝났다.**
  격자는 지연 로딩이라 스크롤을 내려야 붙는데, 안 붙는 계정이 많고 런타임까지 죽었다.
  → **DOM 을 읽지 말고 위 API 를 불러라.** 렌더가 아예 필요 없어서 이 문제가 사라진다.
- **게시물(격자) 탭 DOM 에는 조회수가 아예 없다.** 앵커 `innerText` 가 빈 문자열이고
  hover 를 JS 로 쏴도 오버레이가 안 뜬다. DOM 으로 가려면 `/{핸들}/reels/` 탭이 필수인데
  그게 바로 안 열리는 그 화면이다. 그래서 DOM 경로는 답이 아니다.
- **fetch 를 instagram.com 탭 밖에서 부르면 CORS 로 막힌다.** 반드시 그 탭 안에서 실행한다.
- **`web_profile_info` 의 `edge_owner_to_timeline_media.edges` 는 빈 배열로 온다.**
  게시물은 반드시 `feed/user/{id}` 로 받아야 한다. `.count` 는 정상이다.
- **피드 앞쪽은 고정(pinned) 게시물이라 날짜순이 아니다.** 최근 릴스를 고르려면
  `taken_at` 으로 정렬하고 나서 잘라라. 배열 순서를 그대로 쓰면 옛날 게 섞인다.
- **API `play_count` 와 릴스 탭 화면 표기가 5% 안팎으로 다르다.** 한 산출물에 섞지 마라.
  이 업무는 API 값으로 통일한다.
- **같은 계정을 두 번 부르면 조회수가 조금씩 오른다.** 보고에 기준일을 적어라.
- **시트의 "비공개" 를 믿지 마라.** 대부분 지난 런이 못 본 것이다.
  진짜 비공개는 API 의 `is_private` 로만 판정한다.
- **401 이나 429 가 뜨면 즉시 멈춘다.** 재시도를 반복하면 계정이 잠기고 다음 런까지 막힌다.
  그때까지 채운 행 수와 마지막 핸들을 적고 보고한다.
- **구글 시트를 브라우저로 직접 고치려 들지 마라.** 열 삽입과 헤더 변경은 특히 잘 깨진다.
  claude 런너면 프롬프트로 만들어 codex 에 넘긴다. 자세한 건 사용자 전역 지침에 있다.
- **다른 세션이 같은 시트를 동시에 만진다.** 열 번호가 어긋날 수 있으니 절차 1번을 건너뛰지 마라.

## 사람에게 물어야 하는 지점

- 계정이 잠겨서 로그인을 다시 해야 할 때. 비밀번호는 사람이 넣는다
- 대상 시트가 매뉴얼에 없는 것일 때. 어느 시트 어느 탭인지 확인받는다
- 비공개 계정에 팔로우 요청을 보내야 할 것 같을 때. **보내지 마라.** 상호작용은 이 업무 밖이다
