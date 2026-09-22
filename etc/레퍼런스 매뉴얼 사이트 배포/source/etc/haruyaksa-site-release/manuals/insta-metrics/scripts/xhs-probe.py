# -*- coding: utf-8 -*-
"""샤오홍슈 공개 지표를 연결된 Android 앱에서 읽는다.

사용법: python xhs-probe.py <입력 jsonl> <출력 jsonl>
입력: {"user_id":"표시 ID","nickname":"프로필 닉네임"}

표시 ID와 닉네임으로 앱 안에서 검색하고 프로필의 실제 표시 ID를 다시 대조한다.
고정 노트는 중앙값에서 제외한다.
"""

import html
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path


def adb_path():
    root = Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "WinGet" / "Packages"
    hits = list(root.glob("Google.PlatformTools_*/platform-tools/adb.exe"))
    if not hits:
        raise RuntimeError("adb.exe를 찾지 못했다")
    return str(hits[0])


ADB = adb_path()


def adb(*args, timeout=40):
    return subprocess.run([ADB, *args], capture_output=True, timeout=timeout, check=False)


def dump_xml():
    raw = adb("shell", "uiautomator dump /sdcard/xhs.xml >/dev/null 2>&1; cat /sdcard/xhs.xml").stdout
    return raw.decode("utf-8", "replace")


def attr(node, name):
    return html.unescape(node.attrib.get(name, "")).strip()


def bounds(node):
    values = [int(value) for value in re.findall(r"\d+", node.attrib.get("bounds", ""))]
    return values if len(values) == 4 else [0, 0, 0, 0]


def center(node):
    x1, y1, x2, y2 = bounds(node)
    return (x1 + x2) // 2, (y1 + y2) // 2


def parse_count(value):
    source = str(value or "").strip().replace(",", "")
    match = re.match(r"^([0-9]+(?:\.[0-9]+)?)([KkMm万千만천]?)$", source)
    if not match:
        return None
    number = float(match.group(1))
    unit = match.group(2)
    multiplier = {"": 1, "K": 1000, "k": 1000, "M": 1000000, "m": 1000000,
                  "万": 10000, "만": 10000, "千": 1000, "천": 1000}[unit]
    return int(round(number * multiplier))


def median(values):
    values = sorted(values)
    if not values:
        return None
    n = len(values)
    return values[n // 2] if n % 2 else (values[n // 2 - 1] + values[n // 2]) / 2


def find_exact_user_card(root, nickname):
    wanted = re.sub(r"\s+", "", str(nickname or ""))
    if not wanted:
        return None
    parents = {child: parent for parent in root.iter() for child in parent}
    candidates = []
    for node in root.iter("node"):
        value = re.sub(r"\s+", "", attr(node, "text") or attr(node, "content-desc"))
        if value != wanted:
            continue
        current = node
        for _ in range(8):
            if current.attrib.get("clickable") == "true":
                x1, y1, x2, y2 = bounds(current)
                if 200 <= y1 <= 1100 and y2 - y1 >= 60:
                    candidates.append(current)
                break
            current = parents.get(current)
            if current is None:
                break
    return min(candidates, key=lambda node: bounds(node)[1]) if candidates else None


def parse_profile(xml, note_map):
    root = ET.fromstring(xml)
    nodes = list(root.iter("node"))
    texts = [attr(node, "text") for node in nodes if attr(node, "text")]
    descs = [attr(node, "content-desc") for node in nodes if attr(node, "content-desc")]
    result = {}
    for value in texts:
        match = re.match(r"^(?:rednote\s*아이디|小红书号|RED ?ID)\s*[:：]\s*(.+)$", value, re.I)
        if match:
            result["display_id"] = match.group(1).strip()
        match = re.match(r"^IP\s*[:：]\s*(.+)$", value)
        if match:
            result["ip"] = match.group(1).strip()
    for value in descs + texts:
        match = re.match(r"^([\d.,]+[KkMm万千만천]?)(?:팬|粉丝)$", value)
        if match:
            result["followers"] = parse_count(match.group(1))

    pin_boxes = [bounds(node) for node in nodes
                 if re.search(r"^(?:상단 고정|고정|置顶)$", attr(node, "text") or attr(node, "content-desc"), re.I)]
    for node in nodes:
        desc = attr(node, "content-desc")
        match = re.search(r"(\d+)\s*赞", desc)
        if not match:
            continue
        tile = bounds(node)
        pinned = any(tile[0] <= (pin[0] + pin[2]) // 2 <= tile[2]
                     and tile[1] <= (pin[1] + pin[3]) // 2 <= tile[3] for pin in pin_boxes)
        note_map[desc] = {"likes": int(match.group(1)), "pinned": pinned}
    return result


def search_and_open(query, nickname):
    encoded = urllib.parse.quote(str(query), safe="")
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d",
        f"xhsdiscover://search/result?keyword={encoded}")
    time.sleep(4.5)
    xml = dump_xml()
    card = find_exact_user_card(ET.fromstring(xml), nickname)
    if card is None:
        return False, len(xml)
    x, y = center(card)
    adb("shell", "input", "tap", str(x), str(y))
    time.sleep(4.5)
    return True, len(xml)


def probe(candidate):
    expected = str(candidate.get("display_id") or candidate.get("user_id") or "").strip()
    nickname = str(candidate.get("nickname") or "").strip()
    queries = []
    for value in (expected, nickname):
        if value and value not in queries:
            queries.append(value)

    opened = False
    search_len = 0
    used_query = None
    for query in queries:
        opened, search_len = search_and_open(query, nickname)
        if opened:
            used_query = query
            break
        time.sleep(1.2)
    if not opened:
        return {**candidate, "ok": False, "status": "검색결과없음", "search_xml_len": search_len}

    notes = {}
    profile = parse_profile(dump_xml(), notes)
    actual = str(profile.get("display_id") or "").strip()
    if not actual:
        return {**candidate, "ok": False, "status": "프로필식별실패", "query": used_query}
    if expected and actual.lower() != expected.lower():
        return {**candidate, **profile, "ok": False, "status": "다른계정",
                "actual_id": actual, "query": used_query}

    adb("shell", "input", "swipe", "540", "2100", "540", "700", "650")
    time.sleep(2.5)
    profile.update(parse_profile(dump_xml(), notes))
    regular = [item["likes"] for item in notes.values() if not item["pinned"]]
    pinned = [item["likes"] for item in notes.values() if item["pinned"]]
    med = median(regular)
    return {
        **candidate, **profile, "ok": True,
        "status": "측정" if med is not None else "일반노트없음",
        "query": used_query,
        "note_likes": regular,
        "pinned_likes": pinned,
        "note_count": len(regular),
        "pinned_count": len(pinned),
        "note_likes_median": med,
        "estimated_views": int(round(med * 50)) if med is not None else None,
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def main():
    if len(sys.argv) != 3:
        raise SystemExit("쓰는 법: python xhs-probe.py <입력 jsonl> <출력 jsonl>")
    src, dst = sys.argv[1], sys.argv[2]
    candidates = [json.loads(line) for line in io.open(src, encoding="utf-8") if line.strip()]
    done = set()
    if os.path.exists(dst):
        for line in io.open(dst, encoding="utf-8"):
            try:
                item = json.loads(line)
                done.add(str(item.get("user_id") or item.get("display_id") or ""))
            except Exception:
                pass

    with io.open(dst, "a", encoding="utf-8") as output:
        for index, candidate in enumerate(candidates, start=1):
            key = str(candidate.get("user_id") or candidate.get("display_id") or "")
            if key in done:
                continue
            try:
                result = probe(candidate)
            except Exception as error:
                result = {**candidate, "ok": False, "status": "오류", "error": str(error)[:200]}
            output.write(json.dumps(result, ensure_ascii=False) + "\n")
            output.flush()
            print(f"{index}/{len(candidates)} {key} {result.get('status')}", flush=True)
            time.sleep(1.2)


if __name__ == "__main__":
    main()
