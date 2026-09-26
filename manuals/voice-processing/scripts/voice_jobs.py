"""Offline file batches. Original media stays untouched; transcripts are editable data."""
from __future__ import annotations
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

VERSION = "1"
HERE = Path(__file__).resolve().parent
ENGINES = {"qwen_custom", "cleanup"}
MEDIA = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4", ".mov", ".mkv", ".webm", ".avi"}


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def key(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def absolute(value, exists=False):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"절대경로를 입력하세요: {value}")
    return path.resolve(strict=exists)


def backup(path, root):
    path = Path(path)
    if path.is_file():
        saved = Path(root) / "backups" / digest(path)[:16] / path.name
        saved.parent.mkdir(parents=True, exist_ok=True)
        if not saved.exists():
            shutil.copy2(path, saved)
        return str(saved)


def write_json(path, value, preserve=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if preserve:
        backup(path, path.parent / "etc")
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


@contextlib.contextmanager
def lock(path):
    """OS lock releases automatically if a worker exits or crashes."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    f = path.open("a+b")
    try:
        if os.fstat(f.fileno()).st_size == 0:
            f.write(b"0")
            f.flush()
        f.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("다른 음성 작업이 실행 중입니다. 종료 후 다시 실행하세요.") from exc
        yield
    finally:
        f.close()


def config(path):
    cfg = read_json(absolute(path, True))
    for name in ("runtime_root", "python", "ffmpeg", "ffprobe", "hf_cache", "tts_model", "asr_model", "qwen_source", "qwen_deps", "profiles", "lock"):
        cfg[name] = str(absolute(cfg[name]))
    return cfg


def profiles(cfg):
    result = read_json(HERE.parent / "profiles.json")
    private = Path(cfg["profiles"])
    if private.exists():
        extras = read_json(private)
        if set(extras) & set(result):
            raise ValueError("기본 옵션을 덮어쓸 수 없습니다. 새 ID로 목소리를 추가하세요.")
        result.update(extras)
    for ident, p in result.items():
        if not re.fullmatch(r"[a-z][a-z0-9-]{1,63}", ident) or p.get("engine") not in ENGINES:
            raise ValueError(f"잘못된 목소리 설정: {ident}")
        if p["engine"] == "qwen_custom":
            if not all(p.get(k) for k in ("speaker", "language")) or not isinstance(p.get("instruction"), str):
                raise ValueError(f"화자·언어·말투 설정을 확인하세요: {ident}")
            if not isinstance(p.get("seed"), int):
                raise ValueError(f"seed는 정수여야 합니다: {ident}")
    return result


def run_process(args):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", creationflags=0x08000000 if os.name == "nt" else 0)
    if result.returncode:
        raise RuntimeError(result.stderr[-2400:] or result.stdout[-2400:])
    return result


def probe(cfg, path):
    value = json.loads(run_process([cfg["ffprobe"], "-v", "error", "-select_streams", "a:0", "-show_streams", "-show_format", "-of", "json", path]).stdout)
    if not value.get("streams"):
        raise ValueError("오디오 트랙이 없습니다.")
    stream = value["streams"][0]
    duration = float(stream.get("duration") or value["format"].get("duration", 0))
    if duration <= 0:
        raise ValueError("오디오 길이를 읽을 수 없습니다.")
    return dict(seconds=duration, sample_rate=int(stream["sample_rate"]), channels=stream["channels"], codec=stream["codec_name"])


def extract(cfg, item, output, rate=16000):
    args = [cfg["ffmpeg"], "-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", item["start"], "-i", item["source"]]
    if item["duration"] is not None:
        args += ["-t", item["duration"]]
    run_process(args + ["-map", "0:a:0", "-vn", "-ac", "1", "-ar", rate, "-c:a", "pcm_f32le", output])


def chunks(text, limit=160):
    """Keep sentence boundaries where possible; split long sentences at spaces."""
    pieces, current = [], ""
    for sentence in re.split(r"(?<=[.!?。！？])\s+|\n+", text.strip()):
        words = sentence.split()
        if any(len(w) > limit for w in words):
            raise ValueError("160자가 넘는 연속 문자열이 있습니다. 대사에 띄어쓰기나 줄바꿈을 넣으세요.")
        if len(sentence) <= limit:
            units = [sentence.strip()]
        else:
            units, part = [], ""
            for word in words:
                if len((part + " " + word).strip()) > limit:
                    units.append(part)
                    part = ""
                part = (part + " " + word).strip()
            if part:
                units.append(part)
        for unit in units:
            if not unit:
                continue
            candidate = (current + " " + unit).strip()
            if len(candidate) > limit:
                pieces.append(current)
                current = unit
            else:
                current = candidate
    if current:
        pieces.append(current)
    if not pieces:
        raise ValueError("대사가 비어 있습니다.")
    return pieces


def verify_audio(cfg, path):
    import numpy as np
    import soundfile as sf
    info = probe(cfg, path)
    peak, frames = 0.0, 0
    with sf.SoundFile(path) as f:
        for block in f.blocks(blocksize=65536):
            if not np.isfinite(block).all():
                raise ValueError("출력에 유효하지 않은 음성 값이 있습니다.")
            peak = max(peak, float(np.abs(block).max(initial=0)))
            frames += len(block)
    if not frames or peak <= 0 or peak >= 1:
        raise ValueError("출력이 무음이거나 최대 음량을 초과했습니다.")
    if (info["sample_rate"], info["channels"], info["codec"]) != (48000, 1, "pcm_s24le"):
        raise ValueError("출력 형식이 48 kHz·모노·24비트 WAV가 아닙니다.")
    return dict(**info, peak=peak, sha256=digest(path), listening_verified=False)


def plan(args, cfg):
    catalog = profiles(cfg)
    if args.preset not in catalog:
        raise ValueError(f"없는 목소리 옵션입니다: {args.preset}")
    profile = catalog[args.preset]
    root = absolute(args.output_dir)
    if root == Path(root.anchor):
        raise ValueError("드라이브 루트 대신 작업 폴더를 지정하세요.")
    if args.start < 0 or (args.duration is not None and args.duration <= 0):
        raise ValueError("시작은 0 이상, 길이는 0보다 커야 합니다.")
    seen, sources, items = set(), set(), []
    for value in args.inputs:
        source = absolute(value, True)
        if not source.is_file() or source.suffix.lower() not in MEDIA | {".txt"}:
            raise ValueError(f"지원하지 않는 입력입니다: {source}")
        if str(source).casefold() in sources:
            raise ValueError("입력 파일이 중복되었습니다.")
        sources.add(str(source).casefold())
        if profile["engine"] == "cleanup" and source.suffix.lower() == ".txt":
            raise ValueError("원래 목소리 음량 정리는 녹음 파일이 필요합니다.")
        if source.suffix.lower() == ".txt" and (args.start or args.duration is not None):
            raise ValueError("TXT에는 시간 구간을 적용할 수 없습니다. 읽을 대사를 직접 편집하세요.")
        name = source.stem + "__" + args.preset
        if name.casefold() in seen:
            raise ValueError("이름이 같은 입력이 있습니다. 작업 폴더를 나누어 실행하세요.")
        seen.add(name.casefold())
        output = root / (name + ".wav")
        if output == source:
            raise ValueError("출력 경로가 원본과 같습니다.")
        scratch = root / "etc" / name
        items.append(dict(id=name, source=str(source), source_sha256=digest(source), start=args.start,
                          duration=args.duration, output=str(output), scratch=str(scratch),
                          transcript=str(scratch / "대사.txt"), status="planned"))
    if any(i["output"].casefold() in sources for i in items):
        raise ValueError("출력이 다른 입력 파일을 덮어씁니다. 별도 결과 폴더를 지정하세요.")
    job = dict(schema=1, version=VERSION, preset=args.preset, profile=profile, root=str(root),
               mode="redub" if profile["engine"] == "qwen_custom" else "original_audio",
               timing="새로 생성" if profile["engine"] == "qwen_custom" else "유지",
               items=items, state="planned")
    path = root / "etc" / ("job-" + args.preset + ".json")
    if not args.dry_run:
        write_json(path, job, preserve=True)
    print(json.dumps(dict(job=str(path), dry_run=args.dry_run, **job), ensure_ascii=False, indent=2))


def load_job(path):
    path = absolute(path, True)
    job = read_json(path)
    root = absolute(job["root"])
    if job.get("schema") != 1 or job["profile"].get("engine") not in ENGINES:
        raise ValueError("지원하지 않는 작업 문서입니다.")
    for item in job["items"]:
        for field in ("output", "scratch", "transcript"):
            if not absolute(item[field]).is_relative_to(root):
                raise ValueError(f"작업 폴더 밖의 {field} 경로입니다.")
    return path, job


def check_source(item):
    if digest(item["source"]) != item["source_sha256"]:
        raise ValueError("원본이 작업 계획 후 바뀌었습니다. 새 계획을 만드세요.")


def render_key(cfg, item, profile):
    text_hash = digest(item["transcript"]) if profile["engine"] == "qwen_custom" else None
    return key(dict(source=item["source_sha256"], start=item["start"], duration=item["duration"],
                    text=text_hash, profile=profile, model=cfg["tts_model"], version=VERSION,
                    implementation=digest(__file__) + digest(HERE / "engines.py")))


def batch(args, cfg):
    from engines import Engines
    job_path, job = load_job(args.job)
    with lock(cfg["lock"]):
        engines = Engines(cfg)
        try:
            phases = ["prepare", "render"] if args.command == "run" else [args.command]
            for phase in phases:
                engines.release()
                for item in job["items"]:
                    if phase == "render" and args.command == "run" and item["status"] == "failed":
                        continue
                    scratch = Path(item["scratch"])
                    scratch.mkdir(parents=True, exist_ok=True)
                    try:
                        check_source(item)
                        item.pop("error", None)
                        job["state"] = "running"
                        item["status"] = phase + "_running"
                        job["updated_at"] = time.time()
                        write_json(job_path, job)
                        with (scratch / "engine.log").open("a", encoding="utf-8") as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                            if phase == "prepare":
                                prepare_one(cfg, engines, job, item, refresh=getattr(args, "refresh_transcript", False))
                                item["status"] = "prepared"
                            else:
                                render_one(cfg, engines, job, item)
                                item["status"] = "succeeded"
                    except Exception as exc:
                        item["status"] = "failed"
                        item["error"] = str(exc)
                    write_json(job_path, job)
                    with (job_path.parent / "known_items.txt").open("a", encoding="utf-8") as ledger:
                        ledger.write(json.dumps(dict(id=item["id"], phase=phase, status=item["status"]), ensure_ascii=False) + "\n")
                    print(item["id"] + ": " + item["status"], flush=True)
            job["state"] = "partial_failed" if any(i["status"] == "failed" for i in job["items"]) else ("prepared" if args.command == "prepare" else "succeeded")
            write_json(job_path, job)
        finally:
            engines.release()
    print(json.dumps(dict(state=job["state"], job=str(job_path)), ensure_ascii=False))
    return 1 if job["state"] == "partial_failed" else 0


def prepare_one(cfg, engines, job, item, refresh=False):
    if job["profile"]["engine"] == "cleanup":
        probe(cfg, item["source"])
        return
    transcript = Path(item["transcript"])
    source_key = key({k: item[k] for k in ("source_sha256", "start", "duration")})
    meta = Path(item["scratch"]) / "transcript.json"
    if transcript.exists() and not refresh:
        if not meta.exists() or read_json(meta)["source_key"] != source_key:
            raise ValueError("기존 대사와 입력 구간이 다릅니다. 별도 결과 폴더를 지정하세요.")
        chunks(transcript.read_text(encoding="utf-8-sig"))
        return
    if Path(item["source"]).suffix.lower() == ".txt":
        text = Path(item["source"]).read_text(encoding="utf-8-sig").strip()
        method = "provided_text"
    else:
        audio = Path(item["scratch"]) / "asr-input.wav"
        extract(cfg, item, audio)
        text = engines.transcribe(audio)
        method = "local_whisper; agent review needed"
    chunks(text)
    backup(transcript, Path(item["scratch"]) / "etc")
    backup(meta, Path(item["scratch"]) / "etc")
    transcript.write_text(text + "\n", encoding="utf-8")
    write_json(meta, dict(source_key=source_key, method=method, initial_text=text, reviewed=False))


def render_one(cfg, engines, job, item):
    if job["profile"]["engine"] == "qwen_custom":
        meta = Path(item["scratch"]) / "transcript.json"
        source_key = key({k: item[k] for k in ("source_sha256", "start", "duration")})
        if not meta.exists() or read_json(meta)["source_key"] != source_key:
            raise ValueError("현재 입력에 맞는 대사가 없습니다. prepare를 먼저 실행하세요.")
    cache_key = render_key(cfg, item, job["profile"])
    output = Path(item["output"])
    if item.get("render_key") == cache_key and output.exists() and digest(output) == item.get("audio", {}).get("sha256"):
        item["cached"] = True
        return
    scratch = Path(item["scratch"])
    raw = scratch / "raw.wav"
    if job["profile"]["engine"] == "qwen_custom":
        text = Path(item["transcript"]).read_text(encoding="utf-8-sig").strip()
        engines.synthesize(chunks(text), job["profile"], raw)
    else:
        extract(cfg, item, raw, rate=48000)
    candidate = scratch / "finished.wav"
    if candidate.exists():
        candidate.unlink()
    engines.finish(raw, candidate)
    info = verify_audio(cfg, candidate)
    check_source(item)
    saved = backup(output, Path(job["root"]) / "etc")
    os.replace(candidate, output)
    item.update(render_key=cache_key, audio=info, cached=False)
    if saved:
        item["previous_output_backup"] = saved
    provenance = dict(source=item["source"], source_sha256=item["source_sha256"], mode=job["mode"],
                      timing=job["timing"], profile=job["profile"], transcript=item["transcript"],
                      tts_model=cfg["tts_model"] if job["mode"] == "redub" else None,
                      start=item["start"], duration=item["duration"], render_key=cache_key, audio=info)
    write_json(scratch / "result.json", provenance, preserve=True)


def check_job(cfg, path):
    _, job = load_job(path)
    failures = []
    for item in job["items"]:
        try:
            check_source(item)
            if item["status"] != "succeeded":
                raise ValueError(item.get("error", "생성 전입니다."))
            if render_key(cfg, item, job["profile"]) != item["render_key"]:
                raise ValueError("대사·설정·코드가 결과 생성 후 바뀌었습니다. render로 갱신하세요.")
            info = verify_audio(cfg, item["output"])
            if info["sha256"] != item["audio"]["sha256"]:
                raise ValueError("결과 파일이 생성 후 바뀌었습니다.")
            if job["mode"] == "original_audio":
                original = probe(cfg, item["source"])["seconds"]
                expected = min(original - item["start"], item["duration"] or original)
                if abs(info["seconds"] - expected) > 0.15:
                    raise ValueError("원래 목소리 보정 결과의 길이가 입력 구간과 다릅니다.")
        except Exception as exc:
            failures.append(dict(id=item["id"], error=str(exc)))
    report = dict(ok=not failures, total=len(job["items"]), failures=failures, listening_verified=False)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


def add_profile(args, cfg):
    existing = profiles(cfg)
    if args.id in existing or not re.fullmatch(r"[a-z][a-z0-9-]{1,63}", args.id):
        raise ValueError("기존 ID와 다른 영문 소문자·숫자·하이픈 ID를 쓰세요.")
    speakers = read_json(Path(cfg["tts_model"]) / "config.json")["talker_config"]["spk_id"]
    if args.speaker.lower() not in speakers:
        raise ValueError("지원하는 화자: " + ", ".join(speakers))
    path = Path(cfg["profiles"])
    private = read_json(path) if path.exists() else {}
    private[args.id] = dict(label=args.label, engine="qwen_custom", speaker=args.speaker,
                            language="Korean", instruction=args.instruction, seed=2026,
                            review="candidate", note="새 옵션입니다. 짧은 샘플부터 청취하세요.")
    write_json(path, private, preserve=True)
    print(json.dumps(private[args.id], ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="녹음·영상·대사 TXT를 로컬에서 일괄 처리합니다.")
    parser.add_argument("--config", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor")
    sub.add_parser("profiles")
    p = sub.add_parser("plan")
    p.add_argument("inputs", nargs="+")
    p.add_argument("--preset", default="female-bright")
    p.add_argument("--output-dir", required=True)
    p.add_argument("--start", type=float, default=0)
    p.add_argument("--duration", type=float)
    p.add_argument("--dry-run", action="store_true")
    for cmd in ("prepare", "render", "run", "status", "check"):
        p = sub.add_parser(cmd)
        p.add_argument("job")
        if cmd in ("prepare", "run"):
            p.add_argument("--refresh-transcript", action="store_true")
    p = sub.add_parser("add-profile")
    for arg in ("id", "label", "speaker", "instruction"):
        p.add_argument("--" + arg, required=True)
    args = parser.parse_args()
    cfg = config(args.config)
    os.environ["PATH"] = str(Path(cfg["ffmpeg"]).parent) + os.pathsep + os.environ.get("PATH", "")
    if args.command == "doctor":
        missing = [k for k, v in cfg.items() if k not in ("lock", "profiles") and isinstance(v, str) and not Path(v).exists()]
        result = dict(ok=not missing, missing=missing, profiles=list(profiles(cfg)))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return int(bool(missing))
    if args.command == "profiles":
        print(json.dumps(profiles(cfg), ensure_ascii=False, indent=2))
    elif args.command == "plan":
        with lock(cfg["lock"]):
            plan(args, cfg)
    elif args.command in ("prepare", "render", "run"):
        return batch(args, cfg)
    elif args.command == "status":
        _, job = load_job(args.job)
        print(json.dumps(dict(state=job["state"], items=[{k: v for k, v in i.items() if k in ("id", "status", "error", "output", "cached")} for i in job["items"]]), ensure_ascii=False, indent=2))
    elif args.command == "check":
        return check_job(cfg, args.job)
    elif args.command == "add-profile":
        with lock(cfg["lock"]):
            add_profile(args, cfg)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print("음성 작업 실패: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
