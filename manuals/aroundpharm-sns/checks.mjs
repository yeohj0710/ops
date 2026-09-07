#!/usr/bin/env node
// 어라운드팜 인스타그램 운영 준비물 검사. ops done 이 자동으로 돌리고, P0 이 손으로도 돌린다.
//
// 막는 것은 셋뿐이다.
//   1. 드라이브 운영 폴더가 안 보인다 (드라이브가 안 붙었거나 이름이 바뀜)
//   2. 기획안 글판(기획안.md)이 없다
//   3. 하위 폴더(콘텐츠, 편성표, 리포트)가 없다 → 만들어 주고 알린다
//
// 게시 확인은 API 로 매뉴얼 안에서 한다. 여기서는 파일만 본다.
// 구글 드라이브(G:) 위에서 재귀 fs 호출을 쓰지 않는다. 한 단계씩만 본다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = process.env.OPS_ROOT ?? path.resolve(HERE, "..", "..");
const FOLDER = "[운영] 어라운드팜 인스타그램";
const SUBS = ["콘텐츠", "편성표", "리포트"];

const 실패 = [];
const 알림 = [];

let machine = null;
try {
  machine = JSON.parse(fs.readFileSync(path.join(OPS, "machine.json"), "utf8"));
} catch {
  실패.push("machine.json 을 못 읽는다. node ops.mjs doctor 를 먼저 돌린다");
}

if (!fs.existsSync(path.join(HERE, "기획안.md"))) 실패.push("기획안.md 가 없다. 저장소를 git pull 한다");

if (machine?.drive_root) {
  const root = path.join(machine.drive_root, FOLDER);
  if (!fs.existsSync(root)) {
    실패.push(`운영 폴더가 없다: ${root}. 드라이브가 붙었는지, 폴더 이름이 바뀌지 않았는지 본다`);
  } else {
    for (const s of SUBS) {
      const p = path.join(root, s);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p);
        알림.push(`${s}/ 폴더를 새로 만들었다: ${p}`);
      }
    }
    const content = path.join(root, "콘텐츠");
    const waiting = fs
      .readdirSync(content, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "업로드 완료" && /^\d{10}\s/.test(d.name)).length;
    알림.push(`미게시 폴더 ${waiting}개 (콘텐츠/ 에서 업로드 완료 밖)`);
    const plans = fs.existsSync(path.join(root, "편성표"))
      ? fs.readdirSync(path.join(root, "편성표")).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort()
      : [];
    알림.push(plans.length ? `편성표 ${plans.at(-1)} 까지 있다` : "편성표가 하나도 없다. P1 부터다");
  }
} else if (machine) {
  실패.push("machine.json 에 drive_root 가 없다");
}

for (const a of 알림) console.log("알림  " + a);
for (const f of 실패) console.log("실패  " + f);
if (실패.length) process.exit(1);
console.log("통과. 어라운드팜 운영 폴더와 기획안이 제자리에 있다.");
