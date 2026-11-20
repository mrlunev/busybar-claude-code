"""
Packs the animation frames make-images.mjs writes (build/frames/<name>) into src/animations/<name>.anim with the
firmware's own encoder.

  python3 tools/pack.py [name ...]

Needs a busybar-firmware checkout next to this repository (FIRMWARE overrides the path) and Pillow.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIRMWARE = Path(os.environ.get("FIRMWARE", ROOT.parent.parent / "busybar-firmware"))
sys.path.insert(0, str(FIRMWARE / "scripts"))

from seq2anim import BSBAnimConverter  # noqa: E402

FRAMES = ROOT / "build" / "frames"
OUT = ROOT / "src" / "animations"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    names = sys.argv[1:] or sorted(p.name for p in FRAMES.iterdir() if p.is_dir())
    for name in names:
        target = OUT / f"{name}.anim"
        info = BSBAnimConverter().convert_dir(FRAMES / name, target)
        print(f"src/animations/{target.name}: {target.stat().st_size} bytes, {info.frame_cnt} frames")


if __name__ == "__main__":
    main()
