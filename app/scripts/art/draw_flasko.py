"""Draw "Flasko", labnoteO's original flask mascot, as PNG sprite sheets.

Usage:  python -P app/scripts/art/draw_flasko.py --out app/public/skins/flasko

Original art (CC0-1.0, author "labnoteO"). Every pixel is computed here from
primitives (ellipse, rect, polygon, single pixels) at integer coordinates on
our own grid, so the output does not depend on the Pillow rasteriser. The
script opens no input file of any kind (no images, fonts, network); Pillow is
used only to encode the result. Deterministic: same input, same pixels.

Look (spec section 9): round-bottom flask, clear glass outlined in dark slate,
teal liquid in the lower half with tiny bubbles, a cork stopper worn like a
hat, dot eyes and a small mouth on the glass, a white glint, two stubby feet.
"""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image

FRAME = 32

# Palette (<= 12 colours, all opaque; background is fully transparent).
PALETTE = {
    "slate": (0x2B, 0x34, 0x40),       # outline, eyes, feet
    "glass": (0xE4, 0xF1, 0xF4),       # clear glass, slightly tinted
    "teal": (0x2B, 0xB3, 0xA3),        # liquid
    "teal_hi": (0x7F, 0xE0, 0xD4),     # liquid surface highlight
    "teal_done": (0x3D, 0xCC, 0xBA),   # brighter liquid for "done"
    "white": (0xFF, 0xFF, 0xFF),       # glint, bubbles
    "cork": (0xA0, 0x70, 0x3C),        # stopper
    "cork_dark": (0x7A, 0x52, 0x28),   # stopper shade
    "mouth": (0x8C, 0x3B, 0x3B),       # open mouth
    "cheek": (0xF2, 0xA6, 0xA0),       # blush
    "spark": (0xFF, 0xD3, 0x4D),       # "done" sparkle
}

STATES = {
    # state: (frames, fps)
    "idle": (4, 4),
    "talk": (4, 8),
    "think": (6, 6),
    "done": (6, 10),
}

MANIFEST = {
    "format": 1,
    "id": "flasko",
    "name": "Flasko",
    "author": "labnoteO",
    "licence": "CC0-1.0",
    "version": "1.0.0",
    "description": "A little round-bottom flask that helps with lab notes.",
    "frame": {"width": FRAME, "height": FRAME},
    "states": {
        s: {"sheet": s + ".png", "frames": n, "fps": fps} for s, (n, fps) in STATES.items()
    },
}


class Canvas:
    """A FRAME x FRAME grid of palette names (None = transparent)."""

    def __init__(self):
        self.px = [[None] * FRAME for _ in range(FRAME)]

    def set(self, x, y, colour):
        if 0 <= x < FRAME and 0 <= y < FRAME:
            self.px[y][x] = colour

    def get(self, x, y):
        if 0 <= x < FRAME and 0 <= y < FRAME:
            return self.px[y][x]
        return None

    def rect(self, x0, y0, x1, y1, colour):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.set(x, y, colour)

    def points(self, pts, colour):
        for x, y in pts:
            self.set(x, y, colour)


def ellipse_mask(cx2, cy2, rx2, ry2):
    """Pixels whose centres lie inside an ellipse. Arguments are doubled
    (half-pixel precision with integers only)."""
    out = set()
    for y in range(FRAME):
        for x in range(FRAME):
            dx = (2 * x + 1) - cx2
            dy = (2 * y + 1) - cy2
            if dx * dx * ry2 * ry2 + dy * dy * rx2 * rx2 <= rx2 * rx2 * ry2 * ry2:
                out.add((x, y))
    return out


def rect_mask(x0, y0, x1, y1):
    return {(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)}


def polygon_mask(pts):
    """Even-odd fill of a polygon with integer vertices, sampled at pixel centres."""
    out = set()
    n = len(pts)
    for y in range(FRAME):
        sy = 2 * y + 1
        for x in range(FRAME):
            sx = 2 * x + 1
            inside = False
            for i in range(n):
                ax, ay = pts[i][0] * 2, pts[i][1] * 2
                bx, by = pts[(i + 1) % n][0] * 2, pts[(i + 1) % n][1] * 2
                if (ay > sy) != (by > sy):
                    # Is the sample left of the edge at height sy? (no division)
                    lhs = (sx - ax) * (by - ay)
                    rhs = (bx - ax) * (sy - ay)
                    if (by - ay > 0 and lhs < rhs) or (by - ay < 0 and lhs > rhs):
                        inside = not inside
            if inside:
                out.add((x, y))
    return out


def outline_of(mask):
    return {
        (x, y)
        for (x, y) in mask
        if any((x + dx, y + dy) not in mask for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
    }


def draw_flasko(
    *,
    dy=0,
    squash=0,
    slosh=0,
    eyes="open",
    look=(0, 0),
    mouth="smile",
    bubbles=(),
    bright=False,
    above=(),
    sparkle=None,
):
    """Draw one frame.

    dy: vertical offset (negative = up); squash: 1 = wider and shorter body;
    slosh: liquid tilt (-1, 0, 1); eyes: open/blink; look: pupil offset;
    mouth: smile/open/closed/o; bubbles: (x, y) inside the liquid (body coords);
    above: [(x, y, size)] bubbles in the air (frame coords, size 0 = pop);
    sparkle: (x, y, size) four-point sparkle (frame coords).
    """
    c = Canvas()
    liquid = "teal_done" if bright else "teal"
    oy = dy + squash

    # Body: round-bottom flask, centre x = 16, 19 px wide (doubled coordinates).
    rx2 = 19 + 2 * squash
    ry2 = 17 - 2 * squash
    cy2 = 42 + 2 * oy  # centre y 21; squash keeps the bottom on the ground
    body = ellipse_mask(32, cy2, rx2, ry2)
    neck_top = 8 + oy
    neck = rect_mask(13, neck_top, 19, 15 + oy)
    shape = body | neck
    edge = outline_of(shape)

    surface = 22 + oy  # liquid line
    for (x, y) in shape:
        if (x, y) in edge:
            c.set(x, y, "slate")
            continue
        line = surface + (slosh if x < 16 else -slosh)
        if (x, y) in body and y >= line:
            c.set(x, y, "teal_hi" if y == line else liquid)
        else:
            c.set(x, y, "glass")

    # Bubbles in the liquid (body-relative coordinates, moved with the body).
    for (bx, by) in bubbles:
        if c.get(bx, by + oy) in ("teal", "teal_done"):
            c.set(bx, by + oy, "white")

    # Glint on the upper-left of the glass.
    c.points([(11, 16 + oy), (11, 17 + oy), (12, 15 + oy)], "white")

    # Cork stopper worn like a hat: a slightly tapered block over the neck top.
    cork = polygon_mask([
        (11, neck_top - 4), (22, neck_top - 4), (21, neck_top + 2), (12, neck_top + 2),
    ])
    cork_edge = outline_of(cork)
    for (x, y) in cork:
        if (x, y) in cork_edge:
            c.set(x, y, "slate")
        elif y == neck_top + 1:
            c.set(x, y, "cork_dark")
        else:
            c.set(x, y, "cork")
    c.points([(14, neck_top - 2), (18, neck_top - 1)], "cork_dark")

    # Face, on the glass just above the liquid line.
    ex, ey = look
    left_eye, right_eye = 13 + ex, 19 + ex
    eye_top = 17 + oy + ey
    if eyes == "blink":
        c.points([(left_eye - 1, eye_top + 1), (left_eye, eye_top + 1),
                  (right_eye, eye_top + 1), (right_eye + 1, eye_top + 1)], "slate")
    else:
        c.rect(left_eye, eye_top, left_eye, eye_top + 1, "slate")
        c.rect(right_eye, eye_top, right_eye, eye_top + 1, "slate")
    c.points([(11, 19 + oy), (21, 19 + oy)], "cheek")
    my = 19 + oy
    if mouth == "open":
        c.points([(15, my), (16, my), (17, my), (15, my + 1), (17, my + 1)], "slate")
        c.set(16, my + 1, "mouth")
        c.points([(15, my + 2), (16, my + 2), (17, my + 2)], "slate")
    elif mouth == "closed":
        c.points([(15, my + 1), (16, my + 1), (17, my + 1)], "slate")
    elif mouth == "o":
        c.points([(16, my), (15, my + 1), (17, my + 1), (16, my + 2)], "slate")
    else:  # smile
        c.points([(15, my), (16, my + 1), (17, my)], "slate")

    # Stubby feet (they stay on the ground while squashed).
    fy = 29 + dy
    for fx in (11, 19):
        c.rect(fx, fy, fx + 2, fy + 1, "slate")

    # Bubbles in the air above the stopper (think).
    for (x, y, size) in above:
        if size == 0:  # pop: four specks
            c.points([(x - 1, y - 1), (x + 1, y - 1), (x - 1, y + 1), (x + 1, y + 1)], "teal")
        elif size == 1:
            c.set(x, y, "teal")
        else:
            c.points([(x, y - 1), (x - 1, y), (x + 1, y), (x, y + 1)], "slate")
            c.set(x, y, "white")

    # Four-point sparkle (done).
    if sparkle:
        x, y, size = sparkle
        for i in range(1, size + 1):
            c.points([(x - i, y), (x + i, y), (x, y - i), (x, y + i)], "spark")
        c.set(x, y, "white")

    return c


def frames_for(state):
    if state == "idle":
        return [
            draw_flasko(slosh=0, bubbles=[(14, 26)]),
            draw_flasko(slosh=1, bubbles=[(14, 25)]),
            draw_flasko(slosh=0, eyes="blink", bubbles=[(14, 26)]),
            draw_flasko(slosh=-1, bubbles=[(14, 25)]),
        ]
    if state == "talk":
        rise = [(18, 27), (18, 26), (18, 25), (18, 24)]
        return [
            draw_flasko(mouth="open" if i % 2 == 0 else "closed", bubbles=[rise[i], (12, 25)])
            for i in range(4)
        ]
    if state == "think":
        # Three bubbles leave the stopper one after another, rise to the
        # upper right and pop. Bubble k is at stage (frame - 2k) mod 6.
        stages = [(23, 6, 1), (25, 3, 2), (27, 1, 0)]
        air = [
            [stages[(f - 2 * k) % 6] for k in range(3) if (f - 2 * k) % 6 < 3]
            for f in range(6)
        ]
        return [
            draw_flasko(look=(1, -1), mouth="o" if i in (2, 3) else "closed",
                       bubbles=[(14, 26)], above=a)
            for i, a in enumerate(air)
        ]
    if state == "done":
        hop = [0, -1, -1, 0, 0, 0]
        squash = [0, 0, 0, 1, 0, 0]
        spark = [(26, 10, 1), (26, 10, 2), (26, 10, 2), (26, 10, 1), (26, 4, 1), (26, 4, 2)]
        return [
            draw_flasko(dy=hop[i], squash=squash[i], bright=True,
                       mouth="open" if i in (1, 2) else "smile",
                       bubbles=[(13, 25), (18, 26)], sparkle=spark[i])
            for i in range(6)
        ]
    raise ValueError(state)


def sheet(frames):
    img = Image.new("RGBA", (FRAME * len(frames), FRAME), (0, 0, 0, 0))
    pix = img.load()
    for i, f in enumerate(frames):
        for y in range(FRAME):
            for x in range(FRAME):
                name = f.px[y][x]
                if name is not None:
                    pix[i * FRAME + x, y] = PALETTE[name] + (255,)
    return img


def main(argv=None):
    ap = argparse.ArgumentParser(description="Draw the Flasko sprite sheets.")
    ap.add_argument("--out", required=True, help="output directory")
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for state in STATES:
        sheet(frames_for(state)).save(out / (state + ".png"), format="PNG", optimize=True)
    (out / "manifest.json").write_text(
        json.dumps(MANIFEST, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
