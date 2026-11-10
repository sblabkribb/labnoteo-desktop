"""Tests for draw_flasko.py (run with `python -P app/scripts/art/test_draw_flasko.py`).

-P keeps the user site-packages (Pillow lives there) but drops the script
directory from sys.path; the script under test is loaded by explicit path.
"""
import importlib.util
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "draw_flasko.py"
COMMITTED = HERE.parent.parent / "public" / "skins" / "flasko"
FRAME = 32
STATES = {"idle": (4, 4), "talk": (4, 8), "think": (6, 6), "done": (6, 10)}
SHEETS = {f"{s}.png" for s in STATES}


def load_script():
    spec = importlib.util.spec_from_file_location("draw_flasko", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def rgba(path):
    with Image.open(path) as im:
        im.load()
        return im.size, im.convert("RGBA").tobytes()


class DrawFlaskoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name)
        load_script().main(["--out", str(cls.out)])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_writes_exactly_the_expected_files(self):
        self.assertEqual({p.name for p in self.out.iterdir()}, SHEETS | {"manifest.json"})

    def test_regenerated_pixels_match_committed(self):
        for name in sorted(SHEETS):
            with self.subTest(sheet=name):
                self.assertEqual(rgba(self.out / name), rgba(COMMITTED / name))

    def test_regenerated_manifest_matches_committed(self):
        fresh = json.loads((self.out / "manifest.json").read_text("utf-8"))
        committed = json.loads((COMMITTED / "manifest.json").read_text("utf-8"))
        self.assertEqual(fresh, committed)

    def test_manifest_shape(self):
        m = json.loads((COMMITTED / "manifest.json").read_text("utf-8"))
        self.assertEqual(m["format"], 1)
        self.assertEqual(m["id"], "flasko")
        self.assertEqual(m["licence"], "CC0-1.0")
        self.assertEqual(m["author"], "labnoteO")
        self.assertEqual(m["frame"], {"width": FRAME, "height": FRAME})
        self.assertRegex(m["id"], r"^[a-z0-9-]{3,32}$")
        self.assertEqual(
            set(m),
            {"format", "id", "name", "author", "licence", "version", "description", "frame", "states"},
        )
        for state, (frames, fps) in STATES.items():
            self.assertEqual(m["states"][state], {"sheet": f"{state}.png", "frames": frames, "fps": fps})

    def test_sheet_sizes_palette_and_alpha(self):
        for state, (frames, _) in STATES.items():
            with self.subTest(state=state):
                path = COMMITTED / f"{state}.png"
                (w, h), data = rgba(path)
                self.assertEqual((w, h), (frames * FRAME, FRAME))
                px = {tuple(data[i:i + 4]) for i in range(0, len(data), 4)}
                alphas = {p[3] for p in px}
                self.assertLessEqual(alphas, {0, 255}, "alpha must be 0 or 255 (no anti-aliasing)")
                opaque = {p[:3] for p in px if p[3] == 255}
                self.assertLessEqual(len(opaque), 12)
                self.assertIn(0, alphas, "background must be transparent")

    def test_every_frame_has_content_and_frames_differ(self):
        for state, (frames, _) in STATES.items():
            with Image.open(COMMITTED / f"{state}.png") as im:
                im = im.convert("RGBA")
                cells = [im.crop((i * FRAME, 0, (i + 1) * FRAME, FRAME)).tobytes() for i in range(frames)]
            with self.subTest(state=state):
                for c in cells:
                    self.assertTrue(any(c[3::4]), "empty frame")
                self.assertGreater(len(set(cells)), 1, "animation has no change")

    def test_static_frames_distinguish_states(self):
        firsts = []
        for state in STATES:
            with Image.open(COMMITTED / f"{state}.png") as im:
                firsts.append(im.convert("RGBA").crop((0, 0, FRAME, FRAME)).tobytes())
        self.assertEqual(len(set(firsts)), len(firsts), "frame 0 must differ per state (reduced motion)")

    def test_originality_guard(self):
        src = SCRIPT.read_text("utf-8")
        for bad in ("Image.open", "ImageFont", "urllib", "requests", "http", "imread", "frombuffer"):
            self.assertNotIn(bad, src, f"forbidden: {bad}")
        # No read-mode open(): any open( call must be absent (writes use Image.save / Path.write_text).
        self.assertIsNone(re.search(r"\bopen\(", src), "no open( calls allowed")
        self.assertNotIn("read_bytes", src)
        self.assertNotIn("read_text", src)
        literals = re.findall(r"[\w./\-]+\.(?:png|jpe?g|gif|ttf|otf)\b", src, re.IGNORECASE)
        self.assertLessEqual(set(literals), SHEETS, f"unexpected asset paths: {literals}")


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], "-v"])
