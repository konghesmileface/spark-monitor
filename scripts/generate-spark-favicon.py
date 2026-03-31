#!/usr/bin/env python3
"""Generate Spark Monitor brand favicon set.

Golden lightning bolt on deep-blue background.
Outputs:
  public/favico/spark/   — web favicons
  src-tauri/icons/spark/  — desktop app icons
"""

import math
import struct
from pathlib import Path
from PIL import Image, ImageDraw

# Brand colours
BG_COLOR = (12, 18, 34)       # #0C1222 deep navy
BOLT_COLOR = (232, 168, 56)   # #E8A838 gold
BOLT_HIGHLIGHT = (255, 210, 100)  # lighter gold for inner highlight

ROOT = Path(__file__).resolve().parent.parent
FAVICO_DIR = ROOT / "public" / "favico" / "spark"
ICONS_DIR = ROOT / "src-tauri" / "icons" / "spark"

FAVICO_DIR.mkdir(parents=True, exist_ok=True)
ICONS_DIR.mkdir(parents=True, exist_ok=True)


def draw_lightning(draw: ImageDraw.ImageDraw, size: int):
    """Draw a stylized lightning bolt centered on a square canvas."""
    # Lightning bolt polygon vertices (normalised 0-1, designed for center placement)
    # Classic zigzag lightning shape
    s = size
    pad = s * 0.15  # padding from edges
    w = s - 2 * pad
    h = s - 2 * pad
    ox = pad
    oy = pad

    # Main bolt shape — thick zigzag
    bolt_points = [
        (ox + w * 0.55, oy + h * 0.00),  # top
        (ox + w * 0.30, oy + h * 0.42),  # left notch top
        (ox + w * 0.50, oy + h * 0.40),  # inner notch
        (ox + w * 0.25, oy + h * 0.95),  # bottom tip (offset left for style)
        (ox + w * 0.58, oy + h * 0.52),  # right notch bottom
        (ox + w * 0.42, oy + h * 0.55),  # inner notch 2
        (ox + w * 0.70, oy + h * 0.08),  # back to top-right
    ]

    # Draw shadow / glow (slightly offset, larger)
    shadow_points = [(x + s * 0.01, y + s * 0.01) for x, y in bolt_points]
    draw.polygon(shadow_points, fill=(180, 120, 30))

    # Draw main bolt
    draw.polygon(bolt_points, fill=BOLT_COLOR)

    # Draw small highlight line down the center of the bolt
    if size >= 64:
        highlight_points = [
            (ox + w * 0.52, oy + h * 0.10),
            (ox + w * 0.40, oy + h * 0.42),
            (ox + w * 0.48, oy + h * 0.41),
            (ox + w * 0.38, oy + h * 0.70),
        ]
        draw.line(highlight_points, fill=BOLT_HIGHLIGHT, width=max(1, size // 80))


def make_icon(size: int) -> Image.Image:
    """Create a single icon at the given size."""
    img = Image.new("RGBA", (size, size), (*BG_COLOR, 255))
    draw = ImageDraw.Draw(img)

    # Rounded rectangle background (subtle rounded corners for larger sizes)
    if size >= 64:
        radius = size // 8
        # Draw rounded rect by compositing
        mask = Image.new("L", (size, size), 0)
        mask_draw = ImageDraw.Draw(mask)
        mask_draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
        bg = Image.new("RGBA", (size, size), (*BG_COLOR, 255))
        img = Image.composite(bg, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask)
        draw = ImageDraw.Draw(img)
        # Redraw background with rounded rect
        draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=(*BG_COLOR, 255))

    draw_lightning(draw, size)
    return img


def save_ico(images: list[Image.Image], path: Path):
    """Save multiple sizes into a single .ico file."""
    # Use Pillow's built-in ICO support
    # The first image is the "main", additional sizes are appended
    largest = max(images, key=lambda im: im.size[0])
    largest.save(str(path), format="ICO", sizes=[(im.size[0], im.size[1]) for im in images])


def generate_icns(icon_512: Image.Image, path: Path):
    """Generate a macOS .icns file from a 512px source.

    Uses the simplified approach: create a 1024x1024 (512@2x) PNG
    and use iconutil if available, otherwise just save a large PNG
    that Tauri can use.
    """
    import subprocess
    import tempfile

    icon_1024 = icon_512.resize((1024, 1024), Image.LANCZOS)
    icon_256 = icon_512.resize((256, 256), Image.LANCZOS)
    icon_128 = icon_512.resize((128, 128), Image.LANCZOS)
    icon_64 = icon_512.resize((64, 64), Image.LANCZOS)
    icon_32 = icon_512.resize((32, 32), Image.LANCZOS)
    icon_16 = icon_512.resize((16, 16), Image.LANCZOS)

    with tempfile.TemporaryDirectory() as tmpdir:
        iconset = Path(tmpdir) / "spark.iconset"
        iconset.mkdir()

        # iconutil expects these exact filenames
        icon_16.save(iconset / "icon_16x16.png")
        icon_32.save(iconset / "icon_16x16@2x.png")
        icon_32.save(iconset / "icon_32x32.png")
        icon_64.save(iconset / "icon_32x32@2x.png")
        icon_128.save(iconset / "icon_128x128.png")
        icon_256.save(iconset / "icon_128x128@2x.png")
        icon_256.save(iconset / "icon_256x256.png")
        icon_512.save(iconset / "icon_256x256@2x.png")
        icon_512.save(iconset / "icon_512x512.png")
        icon_1024.save(iconset / "icon_512x512@2x.png")

        try:
            subprocess.run(
                ["iconutil", "-c", "icns", str(iconset), "-o", str(path)],
                check=True, capture_output=True
            )
            print(f"  ✓ {path.name} (iconutil)")
        except (subprocess.CalledProcessError, FileNotFoundError):
            # Fallback: save as PNG (Tauri accepts PNG as icon too)
            icon_512.save(path.with_suffix(".png"))
            print(f"  ✓ {path.with_suffix('.png').name} (fallback PNG, iconutil not available)")


def main():
    print("Generating Spark Monitor icons...")
    print(f"  Background: {BG_COLOR}")
    print(f"  Lightning:  {BOLT_COLOR}")
    print()

    # Generate at all needed sizes
    sizes = {
        16: "favicon-16x16.png",
        32: "favicon-32x32.png",
        180: "apple-touch-icon.png",
        192: "android-chrome-192x192.png",
        512: "android-chrome-512x512.png",
    }

    icons = {}
    for size in sorted(set(sizes.keys()) | {16, 32, 128, 256, 512, 1024}):
        icons[size] = make_icon(size)

    # === Web favicons ===
    print("Web favicons → public/favico/spark/")
    for size, filename in sizes.items():
        out = FAVICO_DIR / filename
        icons[size].save(str(out), "PNG")
        print(f"  ✓ {filename} ({size}x{size})")

    # favicon.ico (multi-size: 16 + 32) — save from 32px, Pillow will resize down
    ico_path = FAVICO_DIR / "favicon.ico"
    icons[32].save(str(ico_path), format="ICO", sizes=[(16, 16), (32, 32)])
    print(f"  ✓ favicon.ico (16+32)")

    # === Desktop icons ===
    print()
    print("Desktop icons → src-tauri/icons/spark/")

    # Standard Tauri icon set
    icons[32].save(str(ICONS_DIR / "32x32.png"), "PNG")
    print("  ✓ 32x32.png")

    icons[128].save(str(ICONS_DIR / "128x128.png"), "PNG")
    print("  ✓ 128x128.png")

    icons[256].save(str(ICONS_DIR / "128x128@2x.png"), "PNG")
    print("  ✓ 128x128@2x.png")

    icons[512].save(str(ICONS_DIR / "icon.png"), "PNG")
    print("  ✓ icon.png (512x512)")

    # Windows .ico (multi-size: 16, 32, 48, 256) — save from 256px source
    icons[256].save(
        str(ICONS_DIR / "icon.ico"), format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (256, 256)]
    )
    print("  ✓ icon.ico (16+32+48+256)")

    # macOS .icns
    generate_icns(icons[512], ICONS_DIR / "icon.icns")

    print()
    print("Done! All Spark icons generated.")


if __name__ == "__main__":
    main()
