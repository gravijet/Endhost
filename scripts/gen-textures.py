#!/usr/bin/env python3
# Procedural pixel textures for Endhost — our own art in The End's palette, not
# Mojang's files. Small 16px tiles, deterministic, meant to be shown with
# image-rendering: pixelated and scaled up in whole multiples.
import os
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "img")
os.makedirs(OUT, exist_ok=True)

# A tiny deterministic PRNG so the speckle is fixed build-to-build.
class R:
    def __init__(self, s): self.s = s
    def next(self):
        self.s = (self.s * 1103515245 + 12345) & 0x7FFFFFFF
        return self.s
    def pick(self, seq): return seq[self.next() % len(seq)]

def speckle(size, palette, seed):
    img = Image.new("RGBA", (size, size))
    px = img.load()
    r = R(seed)
    for y in range(size):
        for x in range(size):
            px[x, y] = palette[0] if r.next() % 100 else palette[0]
    # weighted speckle pass
    r = R(seed)
    for y in range(size):
        for x in range(size):
            px[x, y] = r.pick(palette)
    return img

def A(hexstr):
    h = hexstr.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)

# End Stone GROUND — the page background, and it must READ as the REAL End Stone
# block, not 1.8.8 sand. Sand is a fine, even grain; End Stone is stony and
# CELLULAR: a pale warm base broken up by irregular darker cells and a scatter of
# distinctly darker pits, with an olive cast in the shadows. So we don't just
# speckle a palette — we lay a grained base, then punch in nodules and pits as
# small wrap-around clusters (they tile seamlessly at the block seam), the way the
# real 16px texture looks when a floor of it repeats.
def endstone(size, seed, tones):
    base, light, lite2, mid, dark, pit = tones
    img = Image.new("RGBA", (size, size))
    px = img.load()
    r = R(seed)
    grain = [base] * 9 + [light, light, mid, mid, lite2, dark]
    for y in range(size):
        for x in range(size):
            px[x, y] = grain[r.next() % len(grain)]

    def blob(col, spread):
        cx, cy = r.next() % size, r.next() % size
        for _ in range(spread):
            x = (cx + (r.next() % 3) - 1) % size
            y = (cy + (r.next() % 3) - 1) % size
            px[x, y] = col

    n = max(1, (size * size) // 42)          # scale nodule count with area
    for _ in range(n): blob(dark, 4)         # olive cells
    for _ in range(n * 2 // 3): blob(pit, 2) # darker pits
    for _ in range(n): px[r.next() % size, r.next() % size] = lite2  # bright flecks
    return img

# The ground tone: pale warm stone, mean luma ~200, with olive darks (#94895b /
# #7d7550) that read as End Stone rather than yellow sand.
GROUND = (A("#d8d0a0"), A("#e3dcae"), A("#efe8bd"), A("#c7be8b"), A("#94895b"), A("#7d7550"))
endstone(32, 1337, GROUND).save(os.path.join(OUT, "endstone.png"))

# A brighter, lower-contrast chip for a lit block face (favicons, a plan badge).
LIT = (A("#e6dfae"), A("#efe8bd"), A("#f5efcb"), A("#d8cf98"), A("#b4aa78"), A("#9a9064"))
endstone(16, 1337, LIT).save(os.path.join(OUT, "endstone-lit.png"))

# Purpur: pale magenta-grey block, the End City stone. Same idea, purple grain.
pur = [A("#a878a6")] * 7 + [A("#bb8fb9"), A("#8f5f8d"), A("#8f5f8d"), A("#7a4d78")]
speckle(16, pur, 4242).save(os.path.join(OUT, "purpur.png"))

# The void: near-black with a rare faint purple mote and an even rarer teal one,
# so the page ground reads as the End's emptiness, not a flat fill.
void = [A("#0b0713")] * 60 + [A("#140c22"), A("#140c22"), A("#1b1030"), A("#0e1a1c")]
speckle(32, void, 909).save(os.path.join(OUT, "void.png"))

# Eye of Ender, 16x16, hand-plotted: teal shell, darker rim, a magenta swirl at
# the base and a bright glint — our own read of the item, in pixels.
def eye():
    T = A("#33cfb0"); TD = A("#1c6f60"); TH = A("#7dffe4")
    M = A("#b455c8"); MD = A("#6f2f80"); K = A("#0c1614"); Z = (0, 0, 0, 0)
    g = [
        "................",
        "....TTTTTTTT....",
        "..TTTTTTTTTTTT..",
        ".TTThTTTTTTTTTT.",
        ".TThhTTTTTTTTTT.",
        "TTThTTTTTTTTTTTT",
        "TTTTTTTTTTTTTTTT",
        "TTTTTTTTTTTTTTTT",
        "TTTTTTTTTTTTTTTT",
        "TTTTTTTTTTMMTTTT",
        "TTTTTTTMMMMMMTTT",
        ".TTTTMMMMMMMMMT.",
        ".TTMMMMdMMMMMMT.",
        "..TMMMMMMMMMMT..",
        "....MMMMMMMM....",
        "................",
    ]
    key = {"T": T, "h": TH, "M": M, "d": MD, "k": K, ".": Z}
    img = Image.new("RGBA", (16, 16))
    px = img.load()
    for y, row in enumerate(g):
        for x, ch in enumerate(row):
            c = key.get(ch, T)
            px[x, y] = c
    # dark rim where teal meets transparency, for the item's hard edge
    return img

e = eye()
e.save(os.path.join(OUT, "eye.png"))
e.resize((256, 256), Image.NEAREST).save(os.path.join(OUT, "eye-256.png"))

# --- feature icons, 16x16 pixel glyphs in the End palette ---
IK = {
    "T": A("#35d3b0"),  # portal teal
    "G": A("#ded89e"),  # end stone gold
    "P": A("#a878a6"),  # purpur
    "W": A("#cdc3e0"),  # light outline
    ".": (0, 0, 0, 0),
}

def plot(rows):
    img = Image.new("RGBA", (16, 16))
    px = img.load()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            px[x, y] = IK.get(ch, (0, 0, 0, 0))
    return img

ICONS = {
    "ic-console": [
        "................", "................",
        ".WWWWWWWWWWWWWW.", ".W............W.",
        ".W.TT.........W.", ".W...TT.......W.",
        ".W.TT.........W.", ".W....TTTTT...W.",
        ".W............W.", ".W............W.",
        ".WWWWWWWWWWWWWW.", "......WW........",
        ".....WWWWWW.....", "................",
        "................", "................",
    ],
    "ic-power": [
        "................", "................",
        "......T.........", "......TT........",
        "......TTT.......", "......TTTT......",
        "......TTTTT.....", "......TTTTTT....",
        "......TTTTT.....", "......TTTT......",
        "......TTT.......", "......TT........",
        "......T.........", "................",
        "................", "................",
    ],
    "ic-sleep": [
        "................", ".....GGGG.......",
        "...GGGGGG.......", "..GGGG..........",
        "..GGG...........", ".GGGG...........",
        ".GGG............", ".GGG............",
        ".GGG............", ".GGGG...........",
        "..GGG...........", "..GGGG..........",
        "...GGGGGG.......", ".....GGGG.......",
        "................", "................",
    ],
    "ic-block": [
        "................", "................",
        "..WWWWWWWWWWWW..", "..WGGGGGGGGGGW..",
        "..WGPPPPPPPPGW..", "..WGPPPPPPPPGW..",
        "..WGPPPPPPPPGW..", "..WGPPPPPPPPGW..",
        "..WGPPPPPPPPGW..", "..WGPPPPPPPPGW..",
        "..WGGGGGGGGGGW..", "..WWWWWWWWWWWW..",
        "................", "................",
        "................", "................",
    ],
    "ic-bolt": [
        "................", ".........TTT....",
        "........TTT.....", ".......TTT......",
        "......TTTT......", ".....TTTTTTT....",
        "........TTT.....", ".......TTT......",
        "......TTT.......", ".....TTT........",
        "....TTT.........", "................",
        "................", "................",
        "................", "................",
    ],
    "ic-gauge": [
        "................", "................",
        "............TT..", "............TT..",
        "........TT..TT..", "........TT..TT..",
        "....TT..TT..TT..", "....TT..TT..TT..",
        "....TT..TT..TT..", "..WWWWWWWWWWWW..",
        "................", "................",
        "................", "................",
        "................", "................",
    ],
}
for name, rows in ICONS.items():
    plot(rows).save(os.path.join(OUT, name + ".png"))

print("wrote:", sorted(os.listdir(OUT)))
