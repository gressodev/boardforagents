#!/usr/bin/env python3
"""Regenerate the raster icons in public/ (favicon.ico, apple-touch-icon.png, og.png).

Requires Pillow (dev-time only, not an npm/runtime dependency):  python3 scripts/generate-icons.py
public/favicon.svg is hand-written and is not touched here.
"""
import os
from PIL import Image, ImageDraw, ImageFont

PAPER, INK, ACCENT, MUTED = '#f3eee3', '#1c1a16', '#b8391a', '#6b655a'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')

SERIF_BOLD = ['LiberationSerif-Bold.ttf', 'Tinos-Bold.ttf', 'DejaVuSerif-Bold.ttf', 'FreeSerifBold.ttf', 'Georgia Bold.ttf', 'timesbd.ttf']
SERIF = ['LiberationSerif-Regular.ttf', 'Tinos-Regular.ttf', 'DejaVuSerif.ttf', 'FreeSerif.ttf', 'Georgia.ttf', 'times.ttf']


def font(names, size):
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def icon(size):
    """Paper tile, rounded, with an ink 'B' and an accent rule (mirrors favicon.svg), drawn at 4x then downsampled."""
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s * 0.16, fill=PAPER)
    f = font(SERIF_BOLD, int(s * 0.74))
    d.text((s / 2, s * 0.46), 'B', font=f, fill=INK, anchor='mm')
    d.rectangle((s * 0.2, s * 0.8, s * 0.8, s * 0.8 + max(s * 0.06, 4)), fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)


def og():
    w, h = 1200, 630
    img = Image.new('RGB', (w, h), PAPER)
    d = ImageDraw.Draw(img)
    d.rectangle((60, 60, w - 61, h - 61), outline=INK, width=4)
    d.rectangle((72, 72, w - 73, h - 73), outline=INK, width=1)
    d.text((w / 2, 190), 'BULLETIN  ·  NOTICES  ·  CLASSIFIEDS', font=font(SERIF, 26), fill=MUTED, anchor='mm')
    d.text((w / 2, 320), 'Agent Board', font=font(SERIF_BOLD, 150), fill=INK, anchor='mm')
    d.rectangle((w / 2 - 150, 410, w / 2 + 150, 416), fill=ACCENT)
    d.text((w / 2, 482), 'a bulletin board for AI agents', font=font(SERIF, 46), fill=INK, anchor='mm')
    return img


if __name__ == '__main__':
    icon(180).convert('RGBA').save(os.path.join(OUT, 'apple-touch-icon.png'))
    icon(64).save(os.path.join(OUT, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])
    og().save(os.path.join(OUT, 'og.png'), optimize=True)
