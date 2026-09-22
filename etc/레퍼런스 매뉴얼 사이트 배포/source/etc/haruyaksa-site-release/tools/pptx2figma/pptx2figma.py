# -*- coding: utf-8 -*-
"""PPTX 를 Figma 프레임으로 그대로 옮긴다.

눈으로 보고 다시 그리는 게 아니라 PPTX XML 을 읽어 좌표, 폰트, 굵기, 색, 크롭까지
그대로 재현한다. 세 단계로 나눠 돈다.

  1) python pptx2figma.py prep  <deck.pptx> --out <폴더>
       슬라이드를 뜯어 spec.json 을 만들고 이미지를 표시 크기의 2배로 줄여 담는다.
       마지막 줄에 필요한 업로드 URL 개수가 나온다.

  2) Figma MCP 의 upload_assets 를 그 개수만큼 부른다.
     응답의 uuid 만 한 줄에 하나씩 <폴더>/urls.txt 에 붙여넣는다.
       python pptx2figma.py upload <deck.pptx> --out <폴더>
       -> image_hashes.json 이 생긴다. MCP 호출은 1회로 끝난다.

  3) python pptx2figma.py build <deck.pptx> --out <폴더>
       <폴더>/build/batchNN.js 가 나온다. 파일 내용을 use_figma 의 code 에 그대로 넣는다.
       한 배치가 슬라이드 3장이다.

슬라이드를 골라 뽑으려면 --slides 1,2,5-8 을 준다. 두 덱을 합칠 때는 덱마다 따로
prep 을 돌리고 build 결과를 순서대로 붙이면 된다.

필요한 것: Pillow, curl. 파이썬 표준 라이브러리 외에는 Pillow 뿐이다.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from xml.etree import ElementTree as ET

NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}
A = '{%s}' % NS['a']
P = '{%s}' % NS['p']
R = '{%s}' % NS['r']
EMU = 9525.0          # 1px = 9525 EMU (96dpi)
PT = 4.0 / 3.0        # 1pt = 4/3 px
ALGN = {'ctr': 'CENTER', 'r': 'RIGHT', 'just': 'LEFT', 'l': 'LEFT'}


def px(v):
    return int(v) / EMU


# ---------------------------------------------------------------- 텍스트 읽기

def style_from_typeface(tf, bold):
    """이 회사 덱은 굵기를 b 속성이 아니라 폰트 이름으로 준다.
    rPr 의 b 만 보면 부분 강조가 전부 사라진다."""
    if not tf:
        return 'Bold' if bold else 'Medium'
    tf = tf.strip()
    for suffix in ('SemiBold', 'ExtraBold', 'Bold', 'Medium', 'Light', 'Thin', 'Black'):
        if tf.endswith(suffix):
            return suffix
    return 'Bold' if bold else 'Regular'


def parse_rpr(rpr):
    out = {}
    if rpr is None:
        return out
    if rpr.get('sz'):
        out['sz'] = int(rpr.get('sz')) / 100.0
    lat = rpr.find('a:latin', NS)
    if lat is not None:
        out['tf'] = lat.get('typeface')
    if rpr.get('b') == '1':
        out['b'] = True
    c = rpr.find('a:solidFill/a:srgbClr', NS)
    if c is not None:
        out['color'] = c.get('val')
    u = rpr.get('u')
    if u and u != 'none':
        out['u'] = True
    return out


def read_text(sp, defaults):
    tx = sp.find('p:txBody', NS)
    if tx is None:
        tx = sp.find('a:txBody', NS)
    if tx is None:
        return None
    body = tx.find('a:bodyPr', NS)
    info = {'anchor': 't', 'wrap': 'square',
            'lIns': 9.6, 'tIns': 4.8, 'rIns': 9.6, 'bIns': 4.8, 'scale': 1.0}
    if body is not None:
        info['anchor'] = body.get('anchor') or 't'
        info['wrap'] = body.get('wrap') or 'square'
        for k, d in (('lIns', 9.6), ('tIns', 4.8), ('rIns', 9.6), ('bIns', 4.8)):
            v = body.get(k)
            info[k] = px(v) if v is not None else d
        na = body.find('a:normAutofit', NS)
        if na is not None and na.get('fontScale'):
            info['scale'] = int(na.get('fontScale')) / 100000.0
    paras = []
    for pp in tx.findall('a:p', NS):
        ppr = pp.find('a:pPr', NS)
        algn = ppr.get('algn') if ppr is not None else None
        dpr = parse_rpr(ppr.find('a:defRPr', NS)) if ppr is not None else {}
        runs = []
        for node in pp:
            if node.tag == A + 'r':
                m = dict(defaults)
                m.update(dpr)
                m.update(parse_rpr(node.find('a:rPr', NS)))
                runs.append({
                    't': node.find('a:t', NS).text or '',
                    'sz': m.get('sz', 18.0),
                    'st': style_from_typeface(m.get('tf'), m.get('b')),
                    'c': m.get('color', '000000'),
                    'u': bool(m.get('u')),
                })
            elif node.tag == A + 'br':
                runs.append({'br': True})
        paras.append({'algn': algn, 'runs': runs})
    if not any(r.get('t') for pa in paras for r in pa['runs']):
        return None
    info['paras'] = paras
    return info


# ---------------------------------------------------------------- 도형 읽기

def solid_fill(sp_pr):
    sf = sp_pr.find('a:solidFill/a:srgbClr', NS)
    if sf is None:
        return None
    al = sf.find('a:alpha', NS)
    return {'color': sf.get('val'),
            'op': (int(al.get('val')) / 100000.0) if al is not None else 1.0}


def corner_radius(sp_pr, w, h):
    g = sp_pr.find('a:prstGeom', NS)
    if g is None:
        return 0
    prst = g.get('prst')
    if prst == 'roundRect':
        adj = g.find('a:avLst/a:gd', NS)
        v = int(adj.get('fmla').split()[-1]) / 100000.0 if adj is not None else 0.16667
        return round(min(w, h) * v, 1)
    if prst == 'ellipse':
        return min(w, h) / 2
    return 0


def walk(node, tf, rels, out):
    """도형 트리를 평탄한 목록으로 편다. 그룹은 배율과 이동을 계산해 풀어버린다."""
    for el in node:
        tag = el.tag
        if tag == P + 'grpSp':
            gx = el.find('p:grpSpPr/a:xfrm', NS)
            ntf = tf
            if gx is not None:
                off, ext = gx.find('a:off', NS), gx.find('a:ext', NS)
                choff, chext = gx.find('a:chOff', NS), gx.find('a:chExt', NS)
                cw, ch = px(chext.get('cx')), px(chext.get('cy'))
                sx = px(ext.get('cx')) / cw if cw else 1
                sy = px(ext.get('cy')) / ch if ch else 1
                ntf = {
                    'sx': tf['sx'] * sx, 'sy': tf['sy'] * sy,
                    'dx': tf['dx'] + (px(off.get('x')) - px(choff.get('x')) * sx) * tf['sx'],
                    'dy': tf['dy'] + (px(off.get('y')) - px(choff.get('y')) * sy) * tf['sy'],
                }
            walk(el, ntf, rels, out)
            continue
        if tag not in (P + 'sp', P + 'pic', P + 'graphicFrame', P + 'cxnSp'):
            continue
        xf = el.find('p:xfrm', NS) if tag == P + 'graphicFrame' else el.find('.//a:xfrm', NS)
        if xf is None:
            continue
        off, ext = xf.find('a:off', NS), xf.find('a:ext', NS)
        if off is None or ext is None:
            continue
        rec = {
            'x': round(tf['dx'] + px(off.get('x')) * tf['sx'], 1),
            'y': round(tf['dy'] + px(off.get('y')) * tf['sy'], 1),
            'w': round(px(ext.get('cx')) * tf['sx'], 1),
            'h': round(px(ext.get('cy')) * tf['sy'], 1),
        }
        if tag == P + 'pic':
            blip = el.find('.//a:blip', NS)
            emb = blip.get(R + 'embed') if blip is not None else None
            rec['k'] = 'img'
            rec['src'] = os.path.basename(rels.get(emb, ''))
            sr = el.find('.//a:srcRect', NS)
            if sr is not None:
                g = lambda k: int(sr.get(k) or 0) / 100000.0
                l, t, rr, b = g('l'), g('t'), g('r'), g('b')
                if l or t or rr or b:
                    rec['crop'] = [round(l, 5), round(t, 5),
                                   round(1 - l - rr, 5), round(1 - t - b, 5)]
            out.append(rec)
            continue
        if tag == P + 'graphicFrame':
            tbl = el.find('.//a:tbl', NS)
            if tbl is None:
                continue
            rec['k'] = 'table'
            rec['cols'] = [round(px(g.get('w')), 1) for g in tbl.findall('a:tblGrid/a:gridCol', NS)]
            rec['rows'] = [{
                'h': px(tr.get('h')),
                'cells': [read_text(tc, {'sz': 11.0, 'tf': 'Pretendard Medium', 'color': '1B1917'})
                          for tc in tr.findall('a:tc', NS)],
            } for tr in tbl.findall('a:tr', NS)]
            out.append(rec)
            continue
        sp_pr = el.find('p:spPr', NS)
        fill = solid_fill(sp_pr) if sp_pr is not None else None
        rad = corner_radius(sp_pr, rec['w'], rec['h']) if sp_pr is not None else 0
        ti = read_text(el, {'sz': 18.0, 'tf': 'Pretendard Medium', 'color': '1B1917'})
        if fill:
            out.append(dict(rec, k='box', fill=fill['color'],
                            op=round(fill['op'], 3), rad=rad))
        if ti:
            out.append(dict(rec, k='text', **ti))


# ---------------------------------------------------------------- 덱 읽기

def parse_slide_range(s, n):
    if not s:
        return list(range(1, n + 1))
    got = []
    for part in s.split(','):
        part = part.strip()
        if '-' in part:
            a, b = part.split('-')
            got.extend(range(int(a), int(b) + 1))
        elif part:
            got.append(int(part))
    return [i for i in got if 1 <= i <= n]


def extract(pptx, out):
    raw = os.path.join(out, 'pptx')
    if not os.path.isdir(raw):
        os.makedirs(raw, exist_ok=True)
        with zipfile.ZipFile(pptx) as z:
            z.extractall(raw)
    return raw


def read_deck(raw, wanted):
    pres = ET.parse(os.path.join(raw, 'ppt/presentation.xml')).getroot()
    rels = {c.get('Id'): c.get('Target')
            for c in ET.parse(os.path.join(raw, 'ppt/_rels/presentation.xml.rels')).getroot()}
    order = [os.path.basename(rels[s.get(R + 'id')])
             for s in pres.find('p:sldIdLst', NS)]
    sz = pres.find('p:sldSz', NS)
    size = (round(px(sz.get('cx'))), round(px(sz.get('cy'))))
    idx = parse_slide_range(wanted, len(order))
    slides = []
    for i in idx:
        fn = order[i - 1]
        root = ET.parse(os.path.join(raw, 'ppt/slides', fn)).getroot()
        rp = os.path.join(raw, 'ppt/slides/_rels', fn + '.rels')
        srels = {c.get('Id'): c.get('Target')
                 for c in ET.parse(rp).getroot()} if os.path.exists(rp) else {}
        els = []
        walk(root.find('p:cSld/p:spTree', NS), {'sx': 1, 'sy': 1, 'dx': 0, 'dy': 0}, srels, els)
        slides.append({'no': i, 'name': '%02d' % i, 'els': els})
    return size, slides


# ---------------------------------------------------------------- 1) prep

def cmd_prep(args):
    from PIL import Image
    out = args.out
    os.makedirs(out, exist_ok=True)
    raw = extract(args.pptx, out)
    size, slides = read_deck(raw, args.slides)

    # 이미지마다 슬라이드에서 제일 크게 쓰인 크기를 찾아 그 2배로만 줄여 담는다.
    want = {}
    for s in slides:
        for e in s['els']:
            if e['k'] == 'img' and e['src']:
                w, h = want.get(e['src'], (0, 0))
                want[e['src']] = (max(w, e['w']), max(h, e['h']))

    adir = os.path.join(out, 'assets')
    os.makedirs(adir, exist_ok=True)
    man = {}
    for src, (dw, dh) in sorted(want.items()):
        p = os.path.join(raw, 'ppt/media', src)
        if not os.path.exists(p):
            print('없는 이미지 건너뜀:', src)
            continue
        key = re.sub(r'\W+', '_', os.path.splitext(src)[0])
        im = Image.open(p)
        im.thumbnail((max(int(dw * 2), 1), max(int(dh * 2), 1)), Image.LANCZOS)
        alpha = im.mode in ('RGBA', 'LA') and im.getchannel('A').getextrema()[0] < 255
        if alpha:
            f = os.path.join(adir, key + '.png')
            im.save(f, optimize=True)
        else:
            f = os.path.join(adir, key + '.jpg')
            im.convert('RGB').save(f, quality=88, optimize=True)
        man[key] = {'file': os.path.relpath(f, out).replace('\\', '/'),
                    'src': src, 'w': im.width, 'h': im.height}

    for s in slides:
        for e in s['els']:
            if e['k'] == 'img':
                e['key'] = re.sub(r'\W+', '_', os.path.splitext(e['src'])[0])

    json.dump({'size': size, 'slides': slides},
              open(os.path.join(out, 'spec.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(man, open(os.path.join(out, 'assets.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    total = sum(os.path.getsize(os.path.join(out, v['file'])) for v in man.values())
    print('슬라이드 %d장, 요소 %d개, 슬라이드 크기 %dx%d'
          % (len(slides), sum(len(s['els']) for s in slides), size[0], size[1]))
    print('이미지 %d장, 합계 %dKB -> %s' % (len(man), total // 1024, adir))
    big = [k for k, v in man.items() if os.path.getsize(os.path.join(out, v['file'])) > 10 * 1024 * 1024]
    if big:
        print('10MB 넘어 업로드가 막히는 것:', big)
    print('')
    print('다음: upload_assets 를 count=%d 로 부르고, 응답의 uuid 를 한 줄에 하나씩 %s 에 넣어라.'
          % (len(man), os.path.join(out, 'urls.txt')))


# ---------------------------------------------------------------- 2) upload

def cmd_upload(args):
    out = args.out
    man = json.load(open(os.path.join(out, 'assets.json'), encoding='utf-8'))
    ids = [l.strip() for l in open(os.path.join(out, 'urls.txt'), encoding='utf-8') if l.strip()]
    ids = [re.sub(r'^.*/upload/', '', i).split('/')[0] for i in ids]
    keys = list(man.keys())
    if len(ids) != len(keys):
        sys.exit('urls.txt 가 %d줄인데 이미지는 %d장이다. 개수를 맞춰라.' % (len(ids), len(keys)))

    def post(pair):
        key, uid = pair
        f = os.path.join(out, man[key]['file'])
        url = 'https://mcp.figma.com/mcp/upload/%s/submit?scaleMode=FILL' % uid
        ctype = 'image/png' if f.endswith('.png') else 'image/jpeg'
        r = subprocess.run(['curl', '-s', '-X', 'POST', url,
                            '-F', 'file=@%s;type=%s' % (f, ctype)],
                           capture_output=True, text=True)
        return key, r.stdout

    with ThreadPoolExecutor(max_workers=8) as ex:
        res = list(ex.map(post, zip(keys, ids)))

    hashes, fails = {}, []
    for key, body in res:
        try:
            h = json.loads(body).get('imageHash')
        except Exception:
            h = None
        if h:
            hashes[key] = h
        else:
            fails.append((key, body[:200]))
    json.dump(hashes, open(os.path.join(out, 'image_hashes.json'), 'w', encoding='utf-8'), indent=1)
    print('올린 것 %d장, 실패 %d장' % (len(hashes), len(fails)))
    for f in fails[:5]:
        print(' ', f)
    if not fails:
        print('다음: python pptx2figma.py build ...')


# ---------------------------------------------------------------- 3) build

JS_HEAD = """const F='%(font)s';
for(const st of %(styles)s) await figma.loadFontAsync({family:F,style:st});
const C=h=>({r:parseInt(h.slice(0,2),16)/255,g:parseInt(h.slice(2,4),16)/255,b:parseInt(h.slice(4,6),16)/255});
const page=figma.currentPage;
const ids=[];
const OFF=new Map();
function SL(i,n){const f=figma.createFrame();f.name=n;f.resize(%(W)d,%(H)d);f.clipsContent=true;f.x=(i%%%(cols)d)*%(gx)d;f.y=Math.floor(i/%(cols)d)*%(gy)d;f.fills=[{type:'SOLID',color:C('FFFFFF')}];page.appendChild(f);ids.push(f.id);return f;}
function IM(p,n,x,y,w,h,k){const r=figma.createRectangle();r.name=n;r.resize(Math.max(w,1),Math.max(h,1));r.x=x;r.y=y;r.fills=[{type:'IMAGE',imageHash:IH[k],scaleMode:'FILL'}];p.appendChild(r);return r;}
function IMC(p,n,x,y,w,h,k,c){const r=figma.createRectangle();r.name=n;r.resize(Math.max(w,1),Math.max(h,1));r.x=x;r.y=y;r.fills=[{type:'IMAGE',imageHash:IH[k],scaleMode:'CROP',imageTransform:[[c[2],0,c[0]],[0,c[3],c[1]]]}];p.appendChild(r);return r;}
function BX(p,n,x,y,w,h,c,o,rad){const r=figma.createRectangle();r.name=n;r.resize(Math.max(w,1),Math.max(h,1));r.x=x;r.y=y;r.fills=[{type:'SOLID',color:C(c),opacity:o}];if(rad)r.cornerRadius=rad;p.appendChild(r);return r;}
function GR(p,n,x,y,w,h){const g=figma.createFrame();g.name=n;g.resize(Math.max(w,1),Math.max(h,1));g.x=x;g.y=y;g.fills=[];g.clipsContent=false;p.appendChild(g);OFF.set(g.id,[x,y]);return g;}
function CELL(p,c,x,y,w,h){const q=OFF.get(p.id)||[0,0];const r=figma.createRectangle();r.name='셀';r.resize(w,h);r.x=x-q[0];r.y=y-q[1];r.fills=[{type:'SOLID',color:C(c)}];r.strokes=[{type:'SOLID',color:C('9A9A99')}];r.strokeWeight=1;r.strokeAlign='CENTER';p.appendChild(r);return r;}
function TX(p,n,x,y,w,h,runs,o){
  const t=figma.createText(); t.name=n;
  t.fontName={family:F,style:runs[0][2]}; t.fontSize=runs[0][1];
  t.characters=runs.map(r=>r[0]).join('');
  // resize() 는 textAutoResize 를 NONE 으로 되돌린다. 폭을 준 다음에 다시 건다.
  if(o.wrap){ t.resize(o.tw,10); t.textAutoResize='HEIGHT'; }
  else { t.textAutoResize='WIDTH_AND_HEIGHT'; }
  let i=0;
  for(const r of runs){const j=i+r[0].length;
    if(r[0].length){t.setRangeFontName(i,j,{family:F,style:r[2]});t.setRangeFontSize(i,j,r[1]);t.setRangeFills(i,j,[{type:'SOLID',color:C(r[3])}]);if(r[4])t.setRangeTextDecoration(i,j,'UNDERLINE');}
    i=j;}
  // 줄간격은 폰트가 정하게 둔다. 박스 높이에서 역산해 박으면 글자보다 상자가 짧아진다.
  t.lineHeight={unit:'AUTO'};
  if(o.wrap) t.textAlignHorizontal=o.algn||'LEFT';
  p.appendChild(t);
  const q=OFF.get(p.id)||[0,0];
  let tx;
  if(o.wrap) tx=x+o.lIns;
  else if(o.algn==='CENTER') tx=x+(w-t.width)/2;
  else if(o.algn==='RIGHT') tx=x+w-o.rIns-t.width;
  else tx=x+o.lIns;
  let ty;
  if(o.anchor==='ctr') ty=y+(h-t.height)/2;
  else if(o.anchor==='b') ty=y+h-o.bIns-t.height;
  else ty=y+o.tIns;
  t.x=tx-q[0]; t.y=ty-q[1];
  return t;
}
"""


def jd(v):
    return json.dumps(v, ensure_ascii=False)


def clean_name(s):
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:22] or '텍스트'


def flat_runs(paras, scale):
    runs, lines = [], 0
    for pi, pa in enumerate(paras):
        if pi:
            runs.append(['\n', 12, 'Regular', '000000', False])
            lines += 1
        lines += 1
        for r in pa['runs']:
            if r.get('br'):
                runs.append(['\n', 12, 'Regular', '000000', False])
                lines += 1
            elif r.get('t'):
                runs.append([r['t'], round(r['sz'] * PT * scale, 1),
                             r['st'], r['c'], bool(r.get('u'))])
    for i, r in enumerate(runs):
        if r[0] == '\n':
            ref = runs[i + 1] if i + 1 < len(runs) else (runs[i - 1] if i else None)
            if ref:
                r[1], r[2], r[3] = ref[1], ref[2], ref[3]
    return runs


def emit_text(e, var):
    runs = flat_runs(e['paras'], e.get('scale', 1.0))
    if not runs:
        return ''
    algn = None
    for pa in e['paras']:
        if pa.get('algn'):
            algn = ALGN.get(pa['algn'], 'LEFT')
            break
    opt = {
        'wrap': e.get('wrap', 'square') != 'none',
        'tw': max(round(e['w'] - e['lIns'] - e['rIns'], 1), 20),
        'algn': algn, 'anchor': e.get('anchor', 't'),
        'lIns': e['lIns'], 'rIns': e['rIns'], 'tIns': e['tIns'], 'bIns': e['bIns'],
    }
    name = clean_name('\n'.join(''.join(r.get('t', '') for r in pa['runs']) for pa in e['paras']))
    return 'TX(%s,%s,%s,%s,%s,%s,%s,%s);' % (
        var, jd(name), e['x'], e['y'], e['w'], e['h'], jd(runs), jd(opt))


def emit_table(e, var):
    lines = ['const TB=GR(%s,%s,%s,%s,%s,%s);'
             % (var, jd('표'), e['x'], e['y'], e['w'], e['h'])]
    yy = 0.0
    for ri, row in enumerate(e['rows']):
        xx = 0.0
        for ci, cell in enumerate(row['cells']):
            cw = e['cols'][ci] if ci < len(e['cols']) else e['cols'][-1]
            lines.append('CELL(TB,%s,%s,%s,%s,%s);'
                         % (jd('F1F2F1' if ri == 0 else 'FFFFFF'),
                            round(e['x'] + xx, 1), round(e['y'] + yy, 1),
                            round(cw, 1), round(row['h'], 1)))
            if cell:
                c = dict(cell)
                c.update({'x': round(e['x'] + xx, 1), 'y': round(e['y'] + yy, 1),
                          'w': round(cw, 1), 'h': round(row['h'], 1),
                          'anchor': 'ctr', 'wrap': 'square',
                          'lIns': 5, 'rIns': 5, 'tIns': 3, 'bIns': 3})
                lines.append(emit_text(c, 'TB'))
            xx += cw
        yy += row['h']
    return '\n'.join(lines)


def cmd_build(args):
    out = args.out
    spec = json.load(open(os.path.join(out, 'spec.json'), encoding='utf-8'))
    hp = os.path.join(out, 'image_hashes.json')
    hashes = json.load(open(hp, encoding='utf-8')) if os.path.exists(hp) else {}
    W, H = spec['size']
    head = JS_HEAD % {
        'font': args.font,
        'styles': jd(['Regular', 'Light', 'Medium', 'SemiBold', 'Bold', 'ExtraBold']),
        'W': W, 'H': H, 'cols': args.cols,
        'gx': W + args.gap, 'gy': H + args.gap,
    }
    chunks, keysets = [], []
    for i, s in enumerate(spec['slides']):
        body = ['const f=SL(%d,%s);' % (i + args.start, jd(args.prefix + s['name']))]
        keys = set()
        for e in s['els']:
            if e['k'] == 'img':
                if not hashes.get(e.get('key')):
                    continue
                keys.add(e['key'])
                if e.get('crop'):
                    body.append('IMC(f,%s,%s,%s,%s,%s,%s,%s);'
                                % (jd('이미지 ' + e['key']), e['x'], e['y'], e['w'], e['h'],
                                   jd(e['key']), jd(e['crop'])))
                else:
                    body.append('IM(f,%s,%s,%s,%s,%s,%s);'
                                % (jd('이미지 ' + e['key']), e['x'], e['y'], e['w'], e['h'],
                                   jd(e['key'])))
            elif e['k'] == 'box':
                nm = '배경' if (e['w'] > W * 0.95 and e['h'] > H * 0.95) else ('카드' if e.get('rad') else '박스')
                body.append('BX(f,%s,%s,%s,%s,%s,%s,%s,%s);'
                            % (jd(nm), e['x'], e['y'], e['w'], e['h'],
                               jd(e['fill']), e.get('op', 1), e.get('rad', 0)))
            elif e['k'] == 'text':
                t = emit_text(e, 'f')
                if t:
                    body.append(t)
            elif e['k'] == 'table':
                body.append(emit_table(e, 'f'))
        chunks.append('{\n' + '\n'.join(body) + '\n}')
        keysets.append(keys)

    bdir = os.path.join(out, 'build')
    os.makedirs(bdir, exist_ok=True)
    for old in os.listdir(bdir):
        os.remove(os.path.join(bdir, old))
    n = 0
    for b in range(0, len(chunks), args.batch):
        n += 1
        keys = sorted(set().union(*keysets[b:b + args.batch])) if keysets[b:b + args.batch] else []
        ih = 'const IH={' + ','.join('%s:%s' % (jd(k), jd(hashes[k])) for k in keys) + '};\n'
        code = ih + head + '\n'.join(chunks[b:b + args.batch]) + '\nreturn {createdNodeIds:ids};'
        f = os.path.join(bdir, 'batch%02d.js' % n)
        open(f, 'w', encoding='utf-8').write(code)
        print(f, len(code), '자')
    print('')
    print('각 파일 내용을 use_figma 의 code 에 그대로 넣어라. 50000자를 넘으면 --batch 를 줄인다.')


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('prep', 'upload', 'build'):
        s = sub.add_parser(name)
        s.add_argument('pptx')
        s.add_argument('--out', required=True)
        s.add_argument('--slides', default=None, help='예: 1,2,5-8')
        if name == 'build':
            s.add_argument('--font', default='Pretendard')
            s.add_argument('--cols', type=int, default=5)
            s.add_argument('--gap', type=int, default=160)
            s.add_argument('--batch', type=int, default=3)
            s.add_argument('--start', type=int, default=0, help='격자 시작 번호. 덱을 이어 붙일 때 쓴다')
            s.add_argument('--prefix', default='', help='프레임 이름 앞에 붙일 것')
    args = ap.parse_args()
    {'prep': cmd_prep, 'upload': cmd_upload, 'build': cmd_build}[args.cmd](args)


if __name__ == '__main__':
    main()
