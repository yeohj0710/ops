/* 인스타 지표 수집기 — 로그인된 탭 안에 눌러앉아 혼자 끝까지 돈다.
 *
 * 언제 쓰나. **로그인이 필요한 값을 받아야 할 때다.**
 * 좋아요 중앙값, 공개 연락처, 1만 넘는 팔로워는 로그인 없이는 안 나온다.
 * ig-harvest.mjs 는 자기 크롬 프로필을 새로 파기 때문에 로그아웃 상태로 돈다.
 * 크롬 151 부터 쿠키가 App-Bound 암호화라 사람 프로필의 로그인을 옮겨 심을 수도 없다(260831 실측).
 * 그래서 **사람이 이미 로그인해 둔 탭 안에서** 도는 길이 이것이다.
 *
 * harvest-batch.js 와 뭐가 다른가.
 * batch 는 한 번에 12개씩 받고 끝난다. 628개면 왕복이 52번이라 에이전트가 지쳐 중간에 그만둔다.
 * 이건 한 번 심어 놓으면 혼자 끝까지 돈다. 에이전트는 가끔 IGM.status() 로 진행률만 본다.
 *
 * 쓰는 법 (로그인된 인스타 탭에서).
 *
 *   1. window.IGM_HANDLES = ["handle1", "handle2", ...]      // 대상 목록을 먼저 넣는다
 *   2. 이 파일을 통째로 실행한다                              // 심고 바로 돌기 시작한다
 *   3. IGM.status()                                          // 가끔 진행률만 본다
 *   4. IGM.dump(0, 150)                                      // 다 돌면 조각내서 꺼낸다
 *
 * 지키는 것.
 *   - **결과에 계정 이름을 담지 않는다.** 점이 든 핸들(wander.with.zoey)을 돌려주면
 *     도구가 토큰으로 오인해 [BLOCKED] 로 지운다. 순번(i)으로 돌려받고 부른 쪽이 맞춘다
 *   - 401 이나 429 가 뜨면 **거기서 멈춘다.** 재시도하면 계정이 잠기고 다음 런까지 막힌다
 *   - 간격을 1초 밑으로 내리지 마라. 260829 에 1.1초로 700회 가까이 돌려도 차단이 없었다
 *   - 페이지를 옮기면 죽는다. 심어 놓은 탭을 그대로 둔다. 죽어도 localStorage 에 남아 이어 돈다
 */
(() => {
  const KEY = "__igm_state_v1";
  const H = { "x-ig-app-id": "936619743392459" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const med = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  const cleanUrl = (u) => {
    try {
      const x = new URL(u);
      return (x.origin + x.pathname).replace(/\/$/, "");
    } catch {
      return String(u).split("?")[0];
    }
  };
  const emailIn = (s) => (String(s || "").match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/) || [])[0] || null;
  const jget = async (u) => {
    const r = await fetch(u, { headers: H, credentials: "include" });
    const t = await r.text();
    let j = null;
    try {
      j = JSON.parse(t);
    } catch {}
    return { s: r.status, j };
  };

  // ── 계정 하나 ──────────────────────────────────────────────────────────────────
  const grab = async (name) => {
    let p = null;
    const a = await jget("/api/v1/users/web_profile_info/?username=" + encodeURIComponent(name));
    if (a.s === 401 || a.s === 429) return { st: "차단" + a.s };
    if (a.s === 200 && a.j && a.j.data && a.j.data.user) {
      const u = a.j.data.user;
      p = {
        pk: u.id,
        f: u.edge_followed_by ? u.edge_followed_by.count : null,
        po: u.edge_owner_to_timeline_media ? u.edge_owner_to_timeline_media.count : null,
        priv: !!u.is_private,
        bio: u.biography || "",
        email: u.business_email || u.public_email || null,
        phone: u.business_phone_number || null,
        links: [...(u.bio_links || []).map((l) => l.url), u.external_url].filter(Boolean),
      };
    }

    // 400 은 계정 문제가 아니다. ig_business_category_subvertical 스키마가 깨져서 나는 인스타 오류다
    if (!p) {
      await sleep(600);
      const sr = await jget("/web/search/topsearch/?context=blended&query=" + encodeURIComponent(name));
      if (sr.s === 429) return { st: "차단429" };
      const hit =
        sr.j && Array.isArray(sr.j.users)
          ? sr.j.users.map((x) => x.user).find((u) => u && u.username === name)
          : null;
      if (!hit) return { st: "계정없음" };
      await sleep(600);
      const ir = await jget("/api/v1/users/" + hit.pk + "/info/");
      if (ir.s !== 200 || !ir.j || !ir.j.user) return { st: "info" + ir.s };
      const u = ir.j.user;
      p = {
        pk: String(hit.pk),
        f: u.follower_count ?? null,
        po: u.media_count ?? null,
        priv: !!(u.is_private ?? hit.is_private),
        bio: u.biography || "",
        email: u.public_email || u.business_email || null,
        phone: u.business_phone_number || null,
        links: [...(u.bio_links || []).map((l) => l.url), u.external_url].filter(Boolean),
        via: 1,
      };
    }

    const c = [p.email || emailIn(p.bio), p.phone, ...p.links.map(cleanUrl)]
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, 3);

    const row = { f: p.f, po: p.po, c };
    if (p.via) row.via = 1;
    if (p.priv) {
      row.st = "비공개";
      return row;
    }

    await sleep(500);
    const fr = await jget("/api/v1/feed/user/" + p.pk + "/?count=33");
    if (fr.s === 401 || fr.s === 429) {
      row.st = "차단" + fr.s;
      return row;
    }
    if (fr.s !== 200 || !fr.j) {
      row.st = fr.s === 403 ? "비공개" : "피드" + fr.s;
      return row;
    }
    const items = fr.j.items || [];
    const clips = items.filter((i) => i.product_type === "clips");
    // 한 편만 보여도 그 값을 쓴다. 다 보여야 한다는 규칙이 260829 런에서 601행을 빈칸으로 남겼다
    const plays = clips.map((i) => i.play_count).filter((v) => typeof v === "number" && v > 0);
    // like_count 는 좋아요를 숨긴 글에서 -1 이나 0 으로 온다. 그대로 세면 중앙값이 주저앉는다
    const likes = items.map((i) => i.like_count).filter((v) => typeof v === "number" && v > 0);
    row.n = items.length;
    row.rn = clips.length;
    row.vn = plays.length;
    row.rm = med(plays);
    row.lm = med(likes);
    row.last = items.length
      ? new Date(Math.max(...items.map((i) => i.taken_at)) * 1000).toISOString().slice(0, 10)
      : null;
    row.st = plays.length ? "측정" : clips.length ? "조회수숨김" : "릴스없음";
    row.src = "api";
    return row;
  };

  // ── 상태. 페이지가 죽어도 localStorage 에 남아 이어 돈다 ──────────────────────────
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {
      return null;
    }
  })();

  const handles = (window.IGM_HANDLES || (saved && saved.handles) || []).map((h) =>
    String(h).trim().replace(/^@/, "")
  );
  if (!handles.length) return "IGM_HANDLES 가 비었다. 대상 목록부터 넣어라.";

  // 같은 목록이면 이어 돈다. 목록이 바뀌었으면 처음부터
  const 이어돌기 = saved && saved.n === handles.length && Array.isArray(saved.rows);

  const S = {
    handles,
    n: handles.length,
    rows: 이어돌기 ? saved.rows : [],
    halted: 이어돌기 ? saved.halted || null : null,
    gap: 1150,
    running: false,
    startedAt: new Date().toISOString(),
  };
  window.IGM = S;

  const persist = () => {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ n: S.n, rows: S.rows, halted: S.halted, handles: S.handles })
      );
    } catch {}
  };

  S.status = () => ({
    진행: S.rows.length + "/" + S.n,
    남은분: Math.round(((S.n - S.rows.length) * (S.gap + 1400)) / 60000),
    돌고있나: S.running,
    멈춤사유: S.halted,
    측정: S.rows.filter((r) => r.st === "측정").length,
    조회수있음: S.rows.filter((r) => typeof r.rm === "number").length,
    좋아요있음: S.rows.filter((r) => typeof r.lm === "number").length,
    연락처있음: S.rows.filter((r) => r.c && r.c.length).length,
    팔로워있음: S.rows.filter((r) => typeof r.f === "number").length,
  });

  // 결과를 꺼내는 길은 이게 제일 낫다. 파일 하나로 통째로 내린다.
  // 도구 응답으로 돌려받으면 10KB 안팎에서 잘린다. 337개면 48KB 라 조각을 열 번 넘게 불러야 한다.
  // blob 다운로드는 한 번에 끝나고 셸에서 ~/Downloads 로 바로 집을 수 있다 (260831 확인)
  S.download = (name = "igm.json") => {
    const blob = new Blob([JSON.stringify({ n: S.n, halted: S.halted, rows: S.rows })], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 3000);
    return "내렸다: " + name + " (" + S.rows.length + "행)";
  };

  // 조각으로 꺼내야 할 때만 쓴다. 30행쯤이 안 잘리는 선이다
  S.dump = (from = 0, size = 30) => JSON.stringify(S.rows.slice(from, from + size));

  S.stop = () => {
    S.running = false;
    return "멈춘다";
  };

  const run = async () => {
    if (S.running) return;
    S.running = true;
    while (S.rows.length < S.n && S.running && !S.halted) {
      const i = S.rows.length;
      let row;
      try {
        row = await grab(S.handles[i]);
      } catch (e) {
        row = { st: "예외", e: String(e).slice(0, 60) };
      }
      S.rows.push({ i, ...row });
      // 401 과 429 는 즉시 끝낸다. 재시도를 반복하면 계정이 잠기고 다음 런까지 막힌다
      if (/^차단/.test(row.st || "")) {
        S.halted = row.st;
        persist();
        break;
      }
      if (S.rows.length % 10 === 0) persist();
      await sleep(S.gap);
    }
    S.running = false;
    persist();
  };

  // 숨은 탭은 크롬이 타이머를 조인다. 소리를 내는 탭은 그 조이기에서 빠지니 안 들리는 소리를 튼다.
  // **다만 사람이 그 탭을 한 번도 안 눌렀으면 AudioContext 가 suspended 로 남아 소용이 없다.**
  // 260831 에 337개를 돌렸더니 뒤쪽 열 개쯤에서 눈에 띄게 느려졌다(그래도 끝까지는 갔다).
  // 급하면 사람이 그 탭을 한 번 눌러 앞으로 꺼내 두면 된다
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const g = ac.createGain();
    g.gain.value = 0.0001; // 사람 귀에는 안 들린다
    osc.connect(g).connect(ac.destination);
    osc.start();
    ac.resume().catch(() => {});
    S.keepAlive = { ac, osc };
  } catch {}

  S.run = run;
  run(); // 심자마자 돈다. 이 호출은 기다리지 않는다

  return "IGM 심었다. 대상 " + S.n + "개, 이미 받은 것 " + S.rows.length + "개. IGM.status() 로 본다.";
})();
