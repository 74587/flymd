"""
从任意比例的 PNG 生成 Windows 文件关联专用 ICO。

这里故意不用程序主图标的生成流程，因为文件关联图标和程序图标是两套语义，
混在一起只会让配置越来越脏。
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="src", required=True, help="输入 PNG 路径")
    parser.add_argument("--out", dest="dst", required=True, help="输出 ICO 路径")
    parser.add_argument("--size", type=int, default=1024, help="中间透明画布尺寸")
    parser.add_argument("--fit", type=float, default=0.92, help="内容占画布比例（0~1）")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    src = Path(args.src)
    dst = Path(args.dst)

    if not src.exists():
        raise FileNotFoundError(src)
    if args.size <= 0:
        raise ValueError("--size 必须 > 0")
    if not (0.0 < args.fit <= 1.0):
        raise ValueError("--fit 必须在 (0, 1] 之间")

    image = Image.open(src).convert("RGBA")
    canvas = Image.new("RGBA", (args.size, args.size), (0, 0, 0, 0))

    limit = int(round(args.size * args.fit))
    image.thumbnail((limit, limit), resample=Image.Resampling.LANCZOS)

    x = (args.size - image.width) // 2
    y = (args.size - image.height) // 2
    canvas.paste(image, (x, y), image)

    dst.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(
        dst,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
