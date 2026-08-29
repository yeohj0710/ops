/* 인스타 지표 수집기 — 로그인된 instagram.com 탭 안에 한 번 붙여넣고 쓴다.
 *
 *   IGM.start(["handle1","handle2", ...])   // 바로 반환한다. 뒤에서 계속 돈다
 *   IGM.status()                            // 진행률. 절대 기다리지 않는다
 *   IGM.take(0, 200)                        // 결과를 index 기준으로 잘라서 받는다
 *   IGM.stop()                              // 멈춘다
 *
 * 왜 이렇게 생겼나.
 * - 브라우저 도구의 JS 호출은 45초에서 끊긴다. 계정 하나씩 기다리면 호출이 죽고 그때까지 모은 게
 *   날아간다. 그래서 수집은 떼어 놓고 돌리고, 조회는 sleep 없이 즉시 반환한다.
 * - 결과에 계정 이름을 담지 않는다. 점이 든 핸들(`wander.with.zoey`)을 돌려주면 도구가
 *   토큰으로 오인해 `[BLOCKED]` 로 지운다. 그래서 입력 배열의 index(`i`)만 돌려준다.
 *   부른 쪽이 자기 목록과 맞추면 된다.
 */
(() => {
  const H = { "x-ig-app-id": "936619743392459" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const med = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };

  // 쿼리스트링이 붙은 URL 을 돌려주면 도구가 통째로 지운다. 경로까지만 남긴다.
  const cleanUrl = (u) => {
    try {
      const x = new URL(u);
      return (x.origin + x.pathname).replace(/\/$/, "");
    } catch {
      return String(u).split("?")[0];
    }
  };

  const emailIn = (s) => (String(s || "").match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/) || [])[0] || null;

  const S = {
    names: [],
    done: {},       // index -> row
    at: 0,
    running: false,
    stop: false,
    halted: null,   // 401/429 로 멈춘 사유
    gap: 1200,
  };

  // web_profile_info 는 일부 계정에서 400 을 낸다.
  //   "Asset asset://laser.provider/ig_business_category_subvertical has been deleted"
  // 계정이 없는 게 아니라 인스타 응답 스키마가 깨진 것이다. 260829 표본에서 17개 중 3개가 그랬다.
  // 그 계정들은 topsearch 로 pk 를 찾고 users/{pk}/info/ 로 우회하면 멀쩡히 나온다.
  async function profileByName(name) {
    const r = await fetch(
      "/api/v1/users/web_profile_info/?username=" + encodeURIComponent(name),
      { headers: H, credentials: "include" }
    );
    if (r.status === 401 || r.status === 429) {
      S.halted = "차단 " + r.status;
      S.stop = true;
      return { fail: "차단" + r.status };
    }
    if (r.ok) {
      const u = (await r.json())?.data?.user;
      if (u) {
        return {
          pk: u.id,
          followers: u.edge_followed_by?.count ?? null,
          posts: u.edge_owner_to_timeline_media?.count ?? null,
          priv: !!u.is_private,
          bio: u.biography || "",
          email: u.business_email || u.public_email || null,
          phone: u.business_phone_number || null,
          links: [...(u.bio_links || []).map((l) => l.url), u.external_url].filter(Boolean),
        };
      }
    }
    if (r.status !== 400 && r.status !== 404 && r.status !== 500) return { fail: "프로필" + r.status };

    // 우회 1. 이름으로 pk 를 찾는다
    await sleep(600);
    const sr = await fetch(
      "/web/search/topsearch/?context=blended&query=" + encodeURIComponent(name),
      { headers: H, credentials: "include" }
    );
    if (!sr.ok) return { fail: "검색" + sr.status };
    const hit = ((await sr.json()).users || [])
      .map((x) => x.user)
      .find((u) => u && u.username === name);
    if (!hit) return { fail: "계정없음" };

    // 우회 2. pk 로 프로필을 받는다. 이 엔드포인트에는 깨진 필드가 없다
    await sleep(600);
    const ir = await fetch("/api/v1/users/" + hit.pk + "/info/", { headers: H, credentials: "include" });
    if (!ir.ok) return { fail: "info" + ir.status };
    const u = (await ir.json()).user || {};
    return {
      pk: String(hit.pk),
      followers: u.follower_count ?? null,
      posts: u.media_count ?? null,
      priv: !!(u.is_private ?? hit.is_private),
      bio: u.biography || "",
      email: u.public_email || u.business_email || null,
      phone: u.business_phone_number || null,
      links: [...(u.bio_links || []).map((l) => l.url), u.external_url].filter(Boolean),
      via: "우회",
    };
  }

  async function grab(name) {
    const p = await profileByName(name);
    if (p.fail) return { st: p.fail };

    const contact = [p.email || emailIn(p.bio), p.phone, ...p.links.map(cleanUrl)]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 3);

    const row = { f: p.followers, po: p.posts, c: contact };
    if (p.via) row.via = 1;
    if (p.priv) {
      row.st = "비공개";
      return row;
    }

    await sleep(500);
    const fr = await fetch("/api/v1/feed/user/" + p.pk + "/?count=33", {
      headers: H,
      credentials: "include",
    });
    if (fr.status === 401 || fr.status === 429) {
      S.halted = "차단 " + fr.status;
      S.stop = true;
      row.st = "차단" + fr.status;
      return row;
    }
    if (!fr.ok) {
      row.st = "피드" + fr.status;
      return row;
    }
    const items = (await fr.json()).items || [];
    const clips = items.filter((i) => i.product_type === "clips");

    // 조회수는 보이는 것만 쓴다. 한 편만 보여도 그 값을 쓴다.
    // 하나라도 안 보이면 포기하는 규칙 때문에 지난 런이 601행을 빈칸으로 남겼다.
    const plays = clips.map((i) => i.play_count).filter((v) => typeof v === "number" && v > 0);
    // like_count 는 좋아요를 숨긴 글에서 -1 이나 0 으로 온다. 그대로 세면 중앙값이 0 으로 주저앉는다.
    const likes = items.map((i) => i.like_count).filter((v) => typeof v === "number" && v > 0);

    row.n = items.length;
    row.rn = clips.length;
    row.vn = plays.length;
    row.rm = med(plays);      // 릴스 중앙 조회수. 릴스가 없으면 null 이고, null 이면 시트를 비워 둔다
    row.lm = med(likes);      // 좋아요 중앙값
    row.hid = items.filter((i) => i.like_count === -1 || i.like_count === 0).length;
    row.last = items.length
      ? new Date(Math.max(...items.map((i) => i.taken_at)) * 1000).toISOString().slice(0, 10)
      : null;
    row.st = plays.length ? "측정" : clips.length ? "조회수숨김" : "릴스없음";
    return row;
  }

  async function loop() {
    if (S.running) return;
    S.running = true;
    while (S.at < S.names.length && !S.stop) {
      const i = S.at;
      if (!S.done[i]) {
        try {
          S.done[i] = await grab(S.names[i]);
        } catch (e) {
          S.done[i] = { st: "예외", e: String(e).slice(0, 60) };
        }
      }
      S.at = i + 1;
      await sleep(S.gap);
    }
    S.running = false;
  }

  window.IGM = {
    // names: 핸들 배열. @ 는 떼고 넣는다. 이어서 부르면 뒤에 붙는다
    start(names, opts = {}) {
      if (opts.gap) S.gap = opts.gap;
      if (opts.reset) {
        S.names = [];
        S.done = {};
        S.at = 0;
        S.halted = null;
        S.stop = false;
      }
      const base = S.names.length;
      S.names.push(...names.map((n) => String(n).trim().replace(/^@/, "")));
      loop();
      return { 받음: names.length, 총: S.names.length, 시작index: base };
    },
    status() {
      const rows = Object.values(S.done);
      const by = {};
      for (const r of rows) by[r.st] = (by[r.st] || 0) + 1;
      return {
        총: S.names.length,
        끝난것: rows.length,
        남은것: S.names.length - rows.length,
        돌는중: S.running,
        멈춤사유: S.halted,
        상태분포: by,
      };
    },
    // index 로 잘라서 받는다. 한 번에 200개를 넘기지 마라. 응답이 잘린다
    take(from = 0, count = 200) {
      const out = [];
      for (let i = from; i < Math.min(from + count, S.names.length); i++) {
        if (S.done[i]) out.push({ i, ...S.done[i] });
      }
      return out;
    },
    stop() {
      S.stop = true;
      return "멈춘다";
    },
    resume() {
      S.stop = false;
      S.halted = null;
      loop();
      return "다시 돈다";
    },
  };
  return "IGM 준비됨";
})();
