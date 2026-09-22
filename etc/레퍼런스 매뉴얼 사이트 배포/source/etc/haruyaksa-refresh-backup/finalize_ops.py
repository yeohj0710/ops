from pathlib import Path
import subprocess,zipfile,json,shutil,hashlib
ROOT=Path(r'C:\dev\ops').resolve()
WORK=ROOT/'etc/haruyaksa-refresh-backup'
DRIVE=Path(r'G:\내 드라이브\에이전트').resolve()
# Copy only the two changed manuals and their resources. The general sync command
# recursively deletes every Drive manual and also copies unrelated working changes.
files=['manuals/shorts-pipeline/MANUAL.md','manuals/shorts-refill/MANUAL.md',
 'manuals/shorts-refill/references/수집목록.json','manuals/shorts-refill/references/수집목록.md','manuals/shorts-refill/references/이긴카드.md',
 'manuals/shorts-refill/scripts/collect-winning-cards.mjs','manuals/shorts-refill/scripts/follow-strategy.mjs','manuals/shorts-refill/scripts/follow-metrics.mjs','manuals/shorts-refill/scripts/verify-follow-metrics.mjs']
picked=json.loads((ROOT/'manuals/shorts-refill/references/수집목록.json').read_text('utf-8'))['picked']
files += ['manuals/shorts-refill/references/이긴카드/'+p['file'] for p in picked]
verified=[]
for rel in files:
 src=(ROOT/rel).resolve(); dst=(DRIVE/'매뉴얼'/Path(rel).relative_to('manuals')).resolve()
 assert src.is_relative_to(ROOT) and dst.is_relative_to(DRIVE/'매뉴얼')
 if dst.exists() and dst.read_bytes()!=src.read_bytes():
  backup=DRIVE/'etc/haruyaksa-refresh-backup'/dst.relative_to(DRIVE)
  backup.parent.mkdir(parents=True,exist_ok=True)
  if not backup.exists():shutil.copy2(dst,backup)
 dst.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(src,dst)
 assert src.read_bytes()==dst.read_bytes()
 verified.append({'source':str(src),'destination':str(dst),'sha256':hashlib.sha256(dst.read_bytes()).hexdigest()})
(WORK/'drive-sync-proof.json').write_text(json.dumps({'scope':'두 업무의 변경 파일만 복사. 전체 매뉴얼 삭제와 무관한 설정 백업을 피하기 위해 ops.mjs sync의 복사를 제한했다.','files':verified},ensure_ascii=False,indent=2),encoding='utf-8')
archive=WORK/'committed-site.zip'; release=(ROOT/'etc/haruyaksa-site-release').resolve()
assert archive.is_relative_to(ROOT/'etc') and release.is_relative_to(ROOT/'etc')
assert not release.exists(), 'Do not overwrite an existing release snapshot'
subprocess.run(['git','archive','--format=zip',f'--output={archive}','HEAD'],cwd=ROOT,check=True)
release.mkdir()
with zipfile.ZipFile(archive) as z:
 for n in z.namelist():assert (release/n).resolve().is_relative_to(release)
 z.extractall(release)
metadata=release/'site/dist/.vercel'; metadata.mkdir(parents=True,exist_ok=True)
shutil.copy2(ROOT/'site/dist/.vercel/project.json',metadata/'project.json')
subprocess.run(['node','site/build.mjs'],cwd=release,check=True)
html=(release/'site/dist/index.html').read_text('utf-8')
assert '2,295' in html and '61~70' in html and '기존 소재 38개' in html
print(json.dumps({'drive_files_synced':len(verified),'release':str(release),'ops_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'html_bytes':len(html.encode('utf-8'))},ensure_ascii=False))
