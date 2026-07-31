#!/usr/bin/env python3
# Endhost site art. Source of truth for the two hero assets:
#   - endstone.png / endstone-lit.png : the REAL Mojang End Stone texture
#     (end_stone_1.21.9.png, PrismarineJS minecraft-assets data/1.21.9/blocks),
#     upscaled 16px -> 128px NEAREST so it reads as a stone BLOCK, not fine sand.
#     The user rejected every procedural attempt as "Sand von der 1.8.8"; only the
#     real texture is acceptable. Do NOT regenerate End Stone procedurally.
#   - eye.png / eye-256.png : the Endhost mark, an Eye of Ender (teal orb, bright
#     vertical slit, purple ender swirl, dark outline).
# Run: python3 scripts/gen-assets.py   (writes into public/assets/img)
import math, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
IMGDIR = os.path.join(HERE, '..', 'public', 'assets', 'img')
SRC = os.path.join(HERE, 'end_stone_1.21.9.png')

# ---- 1) real End Stone tile ----
end = Image.open(SRC).convert('RGBA')
end.resize((128, 128), Image.NEAREST).save(os.path.join(IMGDIR, 'endstone.png'))
end.point(lambda v: min(255, int(v * 1.06))).resize((128, 128), Image.NEAREST).save(os.path.join(IMGDIR, 'endstone-lit.png'))
print('endstone tiles written (128px, real Mojang texture)')

# ---- 2) Eye of Ender logo ----
def lerp(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def make_eye(S):
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0)); px = img.load()
    c = (S - 1) / 2.0; R = S / 2.0 - 0.5
    OUT = (7, 38, 32); MID = (43, 196, 162); HI = (150, 250, 222); DK = (22, 120, 99)
    SLIT = (9, 52, 45); CORE = (198, 255, 238)
    PURL = (214, 156, 238); PUR = (168, 95, 212); PURD = (92, 40, 138)
    for y in range(S):
        for x in range(S):
            dx = x - c; dy = y - c; r = math.hypot(dx, dy) / R
            if r > 1.0: continue
            if r > 0.84: px[x, y] = OUT + (255,); continue
            nx = dx / R; ny = dy / R; light = (-nx * 0.55 - ny * 0.72)
            col = lerp(MID, HI, light * 0.85) if light >= 0 else lerp(MID, DK, -light * 0.9)
            pdx = dx / (S * 0.29); pdy = (y - (c + S * 0.22)) / (S * 0.16); pr = pdx * pdx + pdy * pdy
            if pr < 1.0:
                col = lerp(PURL, PURD, pr)
                if pr < 0.18: col = lerp(PURL, PUR, 0.25)
            ex = abs(dx) / (S * 0.085); ey = (y - (c - S * 0.14)) / (S * 0.22)
            if ex * ex + ey * ey < 1.0 and y < c + S * 0.02:
                col = lerp(CORE, SLIT, min(1.0, ex))
            px[x, y] = col + (255,)
    return img

e = make_eye(16)
e.resize((32, 32), Image.NEAREST).save(os.path.join(IMGDIR, 'eye.png'))
e.resize((256, 256), Image.NEAREST).save(os.path.join(IMGDIR, 'eye-256.png'))
print('eye logo written')
