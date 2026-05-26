"""Render the source app icon (1024x1024). One-shot script; not part of the build.

Run from repo root:
    python src-tauri/icons/_source/generate.py
Then regenerate the platform variants:
    npx tauri icon src-tauri/icons/_source/icon.png
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
OUT = Path(__file__).parent / "icon.png"


def squircle_mask(size: int, radius: int) -> Image.Image:
    """Rounded-rect mask. Apple uses true squircles, but a generous radius is close enough at icon scale."""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    img = Image.new("RGB", (size, size), top)
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        # ease in/out for smoother blend
        t = t * t * (3 - 2 * t)
        r = round(top[0] + (bottom[0] - top[0]) * t)
        g = round(top[1] + (bottom[1] - top[1]) * t)
        b = round(top[2] + (bottom[2] - top[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b)
    return img


def radial_light(size: int, cx: float, cy: float, radius: float, color: tuple[int, int, int, int]) -> Image.Image:
    """Soft radial highlight centered at (cx, cy) in pixel coords."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    r2 = radius * radius
    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = y - cy
            d2 = dx * dx + dy * dy
            if d2 >= r2:
                continue
            t = 1.0 - math.sqrt(d2) / radius
            # falloff curve — quadratic for a soft bloom
            a = int(color[3] * (t ** 2.2))
            if a > 0:
                px[x, y] = (color[0], color[1], color[2], a)
    return img


def draw_sparkle(draw: ImageDraw.ImageDraw, cx: float, cy: float, outer: float, inner: float, fill, rotation_deg: float = 0.0) -> None:
    """Four-point star (sparkle). Eight vertices alternating outer/inner radii."""
    pts: list[tuple[float, float]] = []
    for i in range(8):
        angle = math.radians(rotation_deg) + i * math.pi / 4
        r = outer if i % 2 == 0 else inner
        pts.append((cx + math.cos(angle) * r, cy + math.sin(angle) * r))
    draw.polygon(pts, fill=fill)


def build() -> None:
    radius = int(SIZE * 0.225)  # macOS-like generous corner radius

    # ---- base gradient (deep indigo → cyan-blue) -------------------------------------------------
    base = vertical_gradient(SIZE, (62, 88, 214), (15, 30, 78))  # indigo → midnight

    # warm highlight (top-left)
    warm = radial_light(SIZE, SIZE * 0.28, SIZE * 0.22, SIZE * 0.55, (180, 140, 255, 220))
    # cool highlight (bottom-right)
    cool = radial_light(SIZE, SIZE * 0.82, SIZE * 0.88, SIZE * 0.65, (80, 220, 255, 200))

    canvas = base.convert("RGBA")
    canvas = Image.alpha_composite(canvas, warm)
    canvas = Image.alpha_composite(canvas, cool)

    # ---- specular gloss across the top --------------------------------------------------------
    gloss = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    # subtle white horizontal band, blurred
    gd.ellipse(
        (-SIZE * 0.2, -SIZE * 0.55, SIZE * 1.2, SIZE * 0.45),
        fill=(255, 255, 255, 70),
    )
    gloss = gloss.filter(ImageFilter.GaussianBlur(SIZE * 0.05))
    canvas = Image.alpha_composite(canvas, gloss)

    # ---- foreground: glassy sparkle ---------------------------------------------------------------
    fg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fg)
    cx, cy = SIZE / 2, SIZE / 2

    # large soft glow behind the sparkle
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gld = ImageDraw.Draw(glow)
    gld.ellipse(
        (cx - SIZE * 0.32, cy - SIZE * 0.32, cx + SIZE * 0.32, cy + SIZE * 0.32),
        fill=(255, 255, 255, 60),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(SIZE * 0.08))
    fg = Image.alpha_composite(fg, glow)
    fd = ImageDraw.Draw(fg)

    # main sparkle — drop shadow
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    draw_sparkle(sd, cx, cy + SIZE * 0.012, SIZE * 0.34, SIZE * 0.08, (0, 0, 0, 130))
    shadow = shadow.filter(ImageFilter.GaussianBlur(SIZE * 0.018))
    fg = Image.alpha_composite(fg, shadow)
    fd = ImageDraw.Draw(fg)

    # main sparkle — body
    draw_sparkle(fd, cx, cy, SIZE * 0.34, SIZE * 0.08, (255, 255, 255, 245))
    # inner darker tint for depth (right-bottom half)
    inner_shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    isd = ImageDraw.Draw(inner_shadow)
    draw_sparkle(isd, cx + SIZE * 0.006, cy + SIZE * 0.006, SIZE * 0.33, SIZE * 0.075, (140, 180, 255, 60))
    fg = Image.alpha_composite(fg, inner_shadow)
    fd = ImageDraw.Draw(fg)

    # small accent sparkle (top-right)
    draw_sparkle(fd, cx + SIZE * 0.28, cy - SIZE * 0.26, SIZE * 0.075, SIZE * 0.018, (255, 255, 255, 230))
    # tiny accent sparkle (bottom-left)
    draw_sparkle(fd, cx - SIZE * 0.26, cy + SIZE * 0.27, SIZE * 0.05, SIZE * 0.012, (255, 255, 255, 200))

    canvas = Image.alpha_composite(canvas, fg)

    # ---- subtle inner rim ----------------------------------------------------------------------
    rim = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    rd.rounded_rectangle(
        (4, 4, SIZE - 5, SIZE - 5),
        radius=radius - 4,
        outline=(255, 255, 255, 55),
        width=3,
    )
    canvas = Image.alpha_composite(canvas, rim)

    # ---- mask to squircle ---------------------------------------------------------------------
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(canvas, (0, 0), mask=squircle_mask(SIZE, radius))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.save(OUT, "PNG")
    print(f"wrote {OUT} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    build()
