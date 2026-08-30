/* 인스타 지표 수집기 — 한 번에 열몇 개씩, 상태를 안 남기고 결과만 돌려준다.
 *
 * 언제 쓰나. `ig-harvest.mjs` 가 못 도는 자리에서만 쓴다.
 * 셸이 없거나, playwright 가 없거나, 로그인이 꼭 필요한 계정을 봐야 할 때다.
 *
 * 왜 이 모양인가.
 * 도구마다 브라우저 안에서 할 수 있는 게 다르다. Codex 의 브라우저 런타임은 evaluate 가
 * 읽기 전용이라 `window.IGM = ...` 같은 대입이 안 먹는다. 그래서 이 파일은
 * **아무것도 심지 않는다.** 즉시실행 함수 하나가 fetch 를 돌고 배열을 돌려주고 끝난다.
 * 읽기 전용 evaluate 에서도 돌아간다.
 *
 * 쓰는 법. 아래 NAMES 한 줄만 이번 묶음으로 바꿔서 통째로 실행한다.
 *
 *   - **한 번에 12개를 넘기지 마라.** 브라우저 도구의 JS 호출은 45초에서 끊긴다.
 *     한 계정에 2.2초쯤 걸려서 12개면 27초, 15개면 34초다. 12개가 안전선이다
 *   - 한 번 부를 때마다 결과를 harvest.json 에 이어 붙인다. 호출이 죽어도 그 묶음만 잃는다
 *   - 결과에 계정 이름은 안 담는다. 점이 든 핸들(`wander.with.zoey`)을 돌려주면 도구가
 *     토큰으로 오인해 `[BLOCKED]` 로 지운다. 순번(`i`)으로 돌려받고 부른 쪽이 맞춘다
 *   - `st` 가 `차단401` 이나 `차단429` 면 거기서 끝낸다. 재시도하지 마라. 계정이 잠긴다
 */
(async () => {
  const NAMES = ["handle1", "handle2", "handle3"]; // ← 이번 묶음. 12개까지. @ 는 뗀다

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
    // 한 편만 보여도 그 값을 쓴다
    const plays = clips.map((i) => i.play_count).filter((v) => typeof v === "number" && v > 0);
    // like_count 는 좋아요를 숨긴 글에서 -1 이나 0 으로 온다
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

  const out = [];
  for (let i = 0; i < NAMES.length; i++) {
    let row;
    try {
      row = await grab(String(NAMES[i]).trim().replace(/^@/, ""));
    } catch (e) {
      row = { st: "예외", e: String(e).slice(0, 60) };
    }
    out.push({ i, ...row });
    if (/^차단/.test(row.st || "")) break; // 막히면 즉시 끝낸다. 재시도하지 않는다
    await sleep(1200);
  }
  return out;
})();
