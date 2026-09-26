"""Local image input checks. No upload, AI, network, or generation."""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageOps


def inspect(source, width, height):
    path = Path(source).resolve(strict=True)
    with Image.open(path) as raw:
        im = ImageOps.exif_transpose(raw)
        w, h = im.size
        scale = min(width / w, height / h)
        fitted = (max(1, round(w * scale)), max(1, round(h * scale)))
        return {
            "source": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "bytes": path.stat().st_size, "format": raw.format, "mode": im.mode,
            "width": w, "height": h, "target": [width, height], "fit": list(fitted),
            "upscale_needed": scale > 1, "padding_needed": fitted != (width, height),
            "has_icc_profile": bool(raw.info.get("icc_profile")),
            "animated": getattr(raw, "n_frames", 1) > 1,
            "crop_allowed": False, "ready_for_upload": False,
            "remaining": ["프레임에서 제품·라벨·그림자 확인", "현재 모델의 파일 크기·비율·입력 수 제한 대조", "업로드 대상과 공유 범위 확인"],
            "network_calls": 0, "generation_calls": 0,
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument("--out", help="새 점검 JSON 경로. 원본이나 기존 파일을 덮어쓰지 않는다.")
    args = parser.parse_args()
    if args.width <= 0 or args.height <= 0:
        parser.error("가로·세로는 양수여야 합니다.")
    result = inspect(args.source, args.width, args.height)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with Path(args.out).open("x", encoding="utf-8") as handle:
            handle.write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
