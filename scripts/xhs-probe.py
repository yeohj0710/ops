# -*- coding: utf-8 -*-
"""샤오홍슈 후보를 폰으로 한 명씩 읽는다. 읽기만 한다.

  python xhs-probe.py <입력 jsonl> <출력 jsonl>

입력 한 줄 = {"user_id": "...", "nickname": "..."}
프로필 딥링크를 열고 화면을 글자로 받아 필요한 값만 뽑는다.
"""
import json, io, os, re, subprocess, sys, time, html, urllib.parse

ADB = os.path.join(
    os.environ["LOCALAPPDATA"],
    "Microsoft", "WinGet", "Packages",
    "Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe",
    "platform-tools", "adb.exe",
)
TMP = os.path.join(os.environ["LOCALAPPDATA"], "Temp")


def sh(args, **kw):
    return subprocess.run([ADB] + args, capture_output=True, timeout=40, **kw)


def dump():
    """화면 트리를 통째로 받는다. adb pull 은 경로 변환에 걸리니 cat 으로 받는다."""
    r = sh(["shell", "uiautomator dump /sdcard/p.xml >/dev/null 2>&1; cat /sdcard/p.xml"])
    return r.stdout.decode("utf-8", "replace")


NUM = re.compile(r"^[\d.]+[KkMm万千]?$")


def parse(xml, want_uid):
    t = [html.unescape(x) for x in re.findall(r'text="([^"]*)"', xml)]
    d = [html.unescape(x) for x in re.findall(r'content-desc="([^"]*)"', xml)]
    t = [x.strip() for x in t if x.strip()]
    d = [x.strip() for x in d if x.strip()]
    o = {"user_id": want_uid}

    # 닉네임은 아바타 설명에 있다: "头像,里森"
    for x in d:
        if x.startswith("头像,"):
            o["nickname"] = x.split(",", 1)[1]
            break
    if "nickname" not in o and t:
        o["nickname"] = t[0]

    for x in t:
        m = re.match(r"^rednote\s*아이디\s*[:：]\s*(.+)$", x) or re.match(r"^(?:小红书号|RED ?ID)\s*[:：]\s*(.+)$", x)
        if m:
            o["display_id"] = m.group(1).strip()
        m = re.match(r"^IP\s*[:：]\s*(.+)$", x)
        if m:
            o["ip"] = m.group(1).strip()

    # 숫자는 content-desc 쪽이 붙어 있어서 정확하다: "484.2K팬"
    for x in d:
        m = re.match(r"^([\d.]+[KkMm万千]?)(팬|粉丝)$", x)
        if m:
            o["followers"] = m.group(1)
        m = re.match(r"^([\d.]+[KkMm万千]?)(팔로우|关注)$", x)
        if m:
            o["following"] = m.group(1)
        m = re.match(r"^([\d.]+[KkMm万千]?)(받은 좋아요/찜|获赞与收藏)", x)
        if m:
            o["likes_total"] = m.group(1)

    # 노트별 좋아요: "视频,제목,来自닉,146861赞，"
    likes = []
    for x in d:
        m = re.search(r"(\d+)\s*赞", x)
        if m:
            likes.append(int(m.group(1)))
    o["note_likes"] = likes[:12]
    if likes:
        s = sorted(likes[:12])
        n = len(s)
        o["note_likes_median"] = s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0

    # 태그와 bio. 아바타/숫자/버튼이 아닌 desc 를 태그 후보로 본다
    skip = re.compile(r"^(头像|위젯|Header|Personal|뒤로|더 보기|게시물|모음집|搜索|\d)")
    o["tags"] = [x for x in d if not skip.match(x) and len(x) < 20 and not re.search(r"赞|팬|팔로우|좋아요", x)][:8]
    bio = [x for x in t if len(x) > 25 and not x.startswith("rednote")]
    o["bio"] = bio[0][:300] if bio else ""

    # 날짜가 보이면 최근 발신 시점을 안다
    o["dates"] = [x for x in t if re.match(r"^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}|어제|\d+일 전|오늘)", x)][:6]
    o["text_sample"] = t[:24]
    return o


def main():
    src, dst = sys.argv[1], sys.argv[2]
    cands = [json.loads(l) for l in io.open(src, encoding="utf-8") if l.strip()]
    done = set()
    if os.path.exists(dst):
        for l in io.open(dst, encoding="utf-8"):
            try:
                done.add(json.loads(l)["user_id"])
            except Exception:
                pass
    out = io.open(dst, "a", encoding="utf-8")
    for i, c in enumerate(cands):
        uid = c["user_id"]
        if uid in done:
            continue
        try:
            sh(["shell", "am", "start", "-a", "android.intent.action.VIEW",
                "-d", "xhsdiscover://user/" + uid])
            time.sleep(7.0)
            xml = dump()
            if len(xml) < 2000:      # 아직 안 그려졌으면 한 번 더 기다린다
                time.sleep(5.0)
                xml = dump()
            r = parse(xml, uid)
            r["queue_nickname"] = c.get("nickname", "")
            r["ok"] = bool(r.get("followers") or r.get("display_id"))
            r["xml_len"] = len(xml)
        except Exception as e:
            r = {"user_id": uid, "queue_nickname": c.get("nickname", ""), "ok": False,
                 "error": str(e)[:120]}
        out.write(json.dumps(r, ensure_ascii=False) + "\n")
        out.flush()
        sys.stderr.write("%d/%d %s %s\n" % (i + 1, len(cands), uid, "ok" if r.get("ok") else "fail"))
        time.sleep(1.2)
    out.close()


if __name__ == "__main__":
    main()
