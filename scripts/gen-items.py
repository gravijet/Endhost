#!/usr/bin/env python3
# Procedural Minecraft-style ITEM ICONS for the Endhost network selector.
# Our own pixel art in the game's grammar — isometric block cubes + flat item
# sprites — NOT Mojang's files. Deterministic, 64x64 RGBA, meant to be shown
# with image-rendering: pixelated. Each icon is one <id>.png a server can wear
# in the selector.
import os, math
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "img", "items")
os.makedirs(OUT, exist_ok=True)

N = 64  # output size

# deterministic PRNG so the speckle is fixed build-to-build
class R:
    def __init__(self, s): self.s = s & 0x7FFFFFFF
    def n(self):
        self.s = (self.s * 1103515245 + 12345) & 0x7FFFFFFF
        return self.s
    def f(self): return self.n() / 0x7FFFFFFF
    def pick(self, seq): return seq[self.n() % len(seq)]

def A(h, a=255):
    h = h.lstrip("#")
    return (int(h[0:2],16), int(h[2:4],16), int(h[4:6],16), a)

def shade(c, m):
    return (min(255,int(c[0]*m)), min(255,int(c[1]*m)), min(255,int(c[2]*m)), c[3])

# ---------------------------------------------------------------- block faces
# A face is a 16x16 grid of RGBA. Most are a base colour broken by a little
# per-texel noise; a few carry structure (planks, bricks, a furnace mouth).
FT = 16

def noisy(base, tones, seed, weights=None):
    px = [[None]*FT for _ in range(FT)]
    r = R(seed)
    pool = []
    weights = weights or ([9] + [2]*(len(tones)))
    pool += [base]*weights[0]
    for i,t in enumerate(tones): pool += [t]*weights[min(i+1,len(weights)-1)]
    for y in range(FT):
        for x in range(FT):
            px[y][x] = pool[r.n() % len(pool)]
    return px

def solid_tones(hexbase, seed):
    b = A(hexbase)
    return noisy(b, [shade(b,1.12), shade(b,0.88), shade(b,0.78)], seed)

def planks(hexbase, seed, horizontal=True):
    b = A(hexbase); lo = shade(b,0.7); hi = shade(b,1.1)
    px = noisy(b, [shade(b,1.06), shade(b,0.9)], seed)
    for i in range(FT):
        if i % 4 == 0:
            for j in range(FT):
                if horizontal: px[i][j] = lo
                else: px[j][i] = lo
        if i % 4 == 3 and i < FT-1:
            for j in range(FT):
                # stagger the vertical seam like real planks
                pass
    # vertical short seams staggered per row-band
    r = R(seed+7)
    band = -1
    for y in range(FT):
        if y % 4 == 0: band = r.n() % 4
        x = (band + (y//4)*8) % FT
        px[y][x] = lo
    return px

def bricks(seed):
    b = A("#9a4b3b"); mortar = A("#c9c3ba")
    px = noisy(b, [A("#8a4234"), A("#a85748")], seed)
    for y in range(FT):
        if y % 4 == 0:
            for x in range(FT): px[y][x] = mortar
    for y in range(FT):
        off = 0 if (y//4)%2==0 else 4
        for x in range(FT):
            if (x+off) % 8 == 0: px[y][x] = mortar
    return px

def crafting_top(seed):
    b = A("#b08a4f")
    px = planks("#b08a4f", seed)
    grid = A("#6d4f28")
    for y in range(FT):
        for x in range(FT):
            if x in (0,5,10,15) or y in (0,5,10,15): px[y][x] = grid
    return px

def crafting_side(seed):
    px = planks("#9a7742", seed)
    tool = A("#3a3a3a"); wood = A("#6d4f28")
    # a saw / tool motif
    for x in range(3,13): px[4][x] = tool
    for x in range(3,13):
        if x%2==0: px[5][x] = tool
    for y in range(9,13): px[y][6] = wood; px[y][7] = wood
    return px

def furnace_side(seed):
    px = solid_tones("#7c7c7c", seed)
    return px

def furnace_front(seed):
    px = solid_tones("#7c7c7c", seed)
    mouth = A("#2b2b2b"); ember = A("#ff8a1e"); ember2 = A("#ffd257")
    for y in range(8,14):
        for x in range(4,12): px[y][x] = mouth
    for x in range(5,11): px[12][x] = ember if x%2 else ember2
    for x in range(6,10): px[11][x] = ember
    # top vent line
    for x in range(4,12): px[3][x] = A("#565656")
    return px

def tnt_side(seed):
    b = A("#c0392b")
    px = noisy(b, [shade(b,1.1), shade(b,0.85)], seed)
    band = A("#efe9dc"); dark = A("#3a3a3a")
    for y in range(6,10):
        for x in range(FT): px[y][x] = band
    # "TNT"
    letters = A("#2b2b2b")
    for x in range(2,5): px[7][x]=letters
    px[8][3]=letters
    px[7][6]=px[7][7]=px[7][8]=letters; px[8][7]=letters
    for x in range(10,13): px[7][x]=letters
    px[8][11]=letters
    return px

def tnt_top(seed):
    b = A("#d94b3a")
    px = noisy(b, [shade(b,1.1), shade(b,0.85)], seed)
    for y in range(FT):
        for x in range(FT):
            if (x in (0,15) or y in (0,15)): px[y][x] = A("#3a3a3a")
    for y in range(6,10):
        for x in range(6,10): px[y][x] = A("#2b2b2b")
    return px

def bookshelf_side(seed):
    px = planks("#b08a4f", seed)
    cols = [A("#7a2b2b"),A("#2b6a7a"),A("#7a6a2b"),A("#3a7a3a"),A("#5a3a7a"),A("#7a4a2b")]
    r = R(seed+3)
    for band in (4,10):  # two shelves of books
        x = 1
        while x < 15:
            w = r.pick([1,1,2])
            c = r.pick(cols)
            for xx in range(x, min(x+w,15)):
                for yy in range(band, band+4): px[yy][xx] = c if yy!=band else shade(c,0.7)
            x += w
    # plank rails top/bottom of each shelf
    for y in (3,8,9,14):
        for x in range(FT): px[y][x] = A("#6d4f28")
    return px

def grass_top(seed):
    return solid_tones("#5fae3a", seed)

def grass_side(seed):
    px = solid_tones("#8a6a43", seed)  # dirt
    g = A("#5fae3a"); gd = A("#4d8f2f")
    for x in range(FT):
        px[0][x] = g; px[1][x] = g if (x%3) else gd
        if R(seed+x).n()%2: px[2][x] = gd
    return px

# glowstone / ore speckle helpers
def speckled(hexbase, hexspeck, seed, density=6):
    b = A(hexbase); s = A(hexspeck)
    px = noisy(b, [shade(b,1.08), shade(b,0.9)], seed)
    r = R(seed+11)
    for y in range(FT):
        for x in range(FT):
            if r.n()%16 < 2: px[y][x] = s if r.n()%2 else shade(s,1.2)
    return px

# ---------------------------------------------------------------- cube render
def sample(tex, u, v):
    x = min(FT-1, max(0, int(u*FT)))
    y = min(FT-1, max(0, int(v*FT)))
    return tex[y][x]

def draw_face(img, O, U, V, tex, bright):
    # parallelogram O + u*U + v*V, u,v in [0,1]; invert [U V] to get (u,v) per px
    det = U[0]*V[1] - U[1]*V[0]
    if abs(det) < 1e-6: return
    ia, ib = V[1]/det, -V[0]/det
    ic, idd = -U[1]/det, U[0]/det
    xs = [O[0], O[0]+U[0], O[0]+V[0], O[0]+U[0]+V[0]]
    ys = [O[1], O[1]+U[1], O[1]+V[1], O[1]+U[1]+V[1]]
    px = img.load()
    for py in range(int(min(ys))-1, int(max(ys))+2):
        for pxx in range(int(min(xs))-1, int(max(xs))+2):
            if not (0 <= pxx < N and 0 <= py < N): continue
            dx = pxx+0.5 - O[0]; dy = py+0.5 - O[1]
            u = ia*dx + ib*dy
            v = ic*dx + idd*dy
            if -0.001 <= u <= 1.001 and -0.001 <= v <= 1.001:
                c = sample(tex, min(0.999,max(0,u)), min(0.999,max(0,v)))
                px[pxx, py] = shade(c, bright)

def cube(top, left, right):
    img = Image.new("RGBA", (N, N), (0,0,0,0))
    cx, y0 = 32, 8
    rx, ry, h = 26, 13, 26
    L = (cx-rx, y0+ry); T = (cx, y0); B = (cx, y0+2*ry); Rr = (cx+rx, y0+ry)
    # top rhombus: O=L, U=T-L, V=B-L
    draw_face(img, L, (T[0]-L[0],T[1]-L[1]), (B[0]-L[0],B[1]-L[1]), top, 1.0)
    # left face: O=L, U=B-L, V=down
    draw_face(img, L, (B[0]-L[0],B[1]-L[1]), (0,h), left, 0.66)
    # right face: O=B, U=Rr-B, V=down
    draw_face(img, B, (Rr[0]-B[0],Rr[1]-B[1]), (0,h), right, 0.84)
    return img

# ---------------------------------------------------------------- flat items
def canvas(): return Image.new("RGBA", (N,N), (0,0,0,0))

def putbig(img, x, y, c, s=4):
    px = img.load()
    for yy in range(y*s, y*s+s):
        for xx in range(x*s, x*s+s):
            if 0<=xx<N and 0<=yy<N: px[xx,yy] = c

def sprite(rows, pal, s=4):
    img = canvas()
    for y,row in enumerate(rows):
        for x,ch in enumerate(row):
            if ch != '.' and ch in pal: putbig(img, x, y, pal[ch], s)
    return img

def gem(main, seed):
    # a faceted rhombus gem
    b = A(main); hi = shade(b,1.35); lo = shade(b,0.7); gl = A("#ffffff")
    img = canvas(); px = img.load()
    cx, cy = 32, 33; rw, rh = 20, 24
    for y in range(N):
        for x in range(N):
            nx = abs(x-cx)/rw; ny = abs(y-cy)/rh
            if nx+ny <= 1.0:
                if x-cx < -2 and y-cy < 0: c = hi
                elif x-cx > 3 or y-cy > 6: c = lo
                else: c = b
                px[x,y] = c
    # glint
    for (gx,gy) in [(26,18),(27,18),(26,19),(24,22)]:
        px[gx,gy] = gl
    # outline pass (dark rim)
    rim = shade(b,0.45)
    for y in range(1,N-1):
        for x in range(1,N-1):
            if px[x,y][3]==0:
                if px[x-1,y][3] or px[x+1,y][3] or px[x,y-1][3] or px[x,y+1][3]:
                    px[x,y] = rim
    return img

def ingot(main, seed):
    b = A(main); hi = shade(b,1.3); lo = shade(b,0.68); rim = shade(b,0.4)
    img = canvas(); px = img.load()
    # trapezoid bar (wider at bottom) with a lighter top face
    top_y, bot_y = 20, 44
    for y in range(top_y, bot_y):
        t = (y-top_y)/(bot_y-top_y)
        halfw = int(14 + 4*t)
        for x in range(32-halfw, 32+halfw):
            px[x,y] = b
    # top face (parallelogram) lighter
    for y in range(16, 22):
        t = (y-16)/6
        halfw = int(11 + 3*t)
        sh = int(3*(1-t))
        for x in range(32-halfw-sh, 32+halfw-sh):
            px[x,y] = hi
    # shine streak + bottom shade
    for x in range(20,30): px[x,26] = shade(hi,1.1)
    for y in range(38,44):
        for x in range(20,44):
            if px[x,y][3]: px[x,y] = lo if (x-20+y)%7<2 else b
    # rim
    for y in range(1,N-1):
        for x in range(1,N-1):
            if px[x,y][3]==0 and (px[x-1,y][3] or px[x+1,y][3] or px[x,y-1][3] or px[x,y+1][3]):
                px[x,y] = rim
    return img

def nether_star():
    img = canvas(); px = img.load()
    cx, cy = 32, 32
    core = A("#fff7c2"); mid = A("#fde89a"); edge = A("#d9c25a")
    for y in range(N):
        for x in range(N):
            dx, dy = x-cx, y-cy
            d = math.hypot(dx, dy)
            ang = math.atan2(dy, dx)
            # 6-point star radius
            spikes = 6
            rr = 8 + 18*max(0, math.cos(spikes*ang))**0.6
            if d <= rr:
                px[x,y] = core if d<7 else (mid if d<14 else edge)
    # dark rim
    rim = A("#7a6a2a")
    for y in range(1,N-1):
        for x in range(1,N-1):
            if px[x,y][3]==0 and (px[x-1,y][3] or px[x+1,y][3] or px[x,y-1][3] or px[x,y+1][3]):
                px[x,y] = rim
    return img

def ender_eye():
    img = canvas(); px = img.load()
    cx, cy = 32, 32
    for y in range(N):
        for x in range(N):
            d = math.hypot(x-cx, y-cy)
            if d <= 22:
                # green pearl with speckle
                base = A("#2fae7a"); dark = A("#1c7a55"); lite = A("#57d69a")
                r = R(x*131+y*17)
                c = base
                if r.n()%5==0: c = dark
                elif r.n()%7==0: c = lite
                px[x,y] = c
    # cat-eye pupil (dark vertical slit + purple glow)
    for y in range(20,44):
        w = 2 if 26<y<38 else 1
        for x in range(cx-w, cx+w):
            px[x,y] = A("#241033")
    for y in range(26,38):
        px[cx-1,y] = A("#3a1a52"); px[cx,y] = A("#241033")
    # rim
    rim = A("#155a3f")
    for y in range(1,N-1):
        for x in range(1,N-1):
            if px[x,y][3]==0 and (px[x-1,y][3] or px[x+1,y][3] or px[x,y-1][3] or px[x,y+1][3]):
                px[x,y] = rim
    return img

def diamond_sword():
    # 16px sprite, classic diagonal sword, scaled x4
    B='#5ef2e8'; b='#31c7bd'; d='#1c7a73'; H='#6d4f28'; h='#4a331a'; G='#c9c3ba'; k='#2b2b2b'
    pal = {'B':A(B),'b':A(b),'d':A(d),'H':A(H),'h':A(h),'G':A(G),'k':A(k)}
    rows = [
        "............kBk.",
        "...........kBBk",
        "..........kBbBk",
        ".........kBbBk.",
        "........kBbBk..",
        ".......kBbBk...",
        "......kBbBk....",
        ".....kBbBk.....",
        "....kBdBk......",
        "...kGBdk.......",
        "..kGGGGk.......",
        ".kHGGGh........",
        "kHHhHk.........",
        ".kHhk..........",
        "..kk...........",
        "...............",
    ]
    return sprite(rows, pal)

def compass():
    img = canvas(); px = img.load()
    cx, cy = 32, 32
    rim = A("#3a3a3a"); face = A("#d9d4c8"); face2=A("#b9b4a6")
    for y in range(N):
        for x in range(N):
            d = math.hypot(x-cx,y-cy)
            if d <= 24: px[x,y] = rim
            if d <= 20: px[x,y] = face if (x+y)%2 else face2
    # needle: red north, white south
    red = A("#d23b2b"); wht = A("#e8e8e8")
    for i in range(-14,1):
        px[cx,cy+i] = red; px[cx-1,cy+i] = red
    for i in range(0,15):
        px[cx,cy+i] = wht; px[cx-1,cy+i] = wht
    for k in range(4):
        px[cx-1-k,cy-10+k]=red; px[cx+k,cy-10+k]=red
    return img

def apple(body, seed):
    img = canvas(); px = img.load()
    b = A(body); hi = shade(b,1.3); lo = shade(b,0.7)
    cx, cy = 32, 36
    for y in range(N):
        for x in range(N):
            dx=(x-cx)/20.0; dy=(y-cy)/20.0
            if dx*dx+dy*dy <= 1.0:
                px[x,y] = hi if (x-cx<-4 and y-cy<-2) else (lo if (x-cx>6 or y-cy>8) else b)
    # notch top
    for x in range(cx-3,cx+3):
        px[x,16]=(0,0,0,0); px[x,17]=(0,0,0,0)
    # stem + leaf
    for y in range(12,20): px[cx,y]=A("#6d4f28"); px[cx+1,y]=A("#4a331a")
    for (lx,ly) in [(cx+2,14),(cx+3,13),(cx+4,13),(cx+3,14),(cx+4,14),(cx+5,14)]:
        px[lx,ly]=A("#4d8f2f")
    # glint
    for (gx,gy) in [(24,24),(25,24),(24,25)]: px[gx,gy]=A("#ffffff")
    rim = shade(b,0.4)
    for y in range(1,N-1):
        for x in range(1,N-1):
            if px[x,y][3]==0 and (px[x-1,y][3] or px[x+1,y][3] or px[x,y-1][3] or px[x,y+1][3]):
                px[x,y] = rim
    return img

# ---------------------------------------------------------------- catalogue
def build():
    icons = {}
    # blocks (top, left, right = same texture unless noted)
    def b1(hexc, seed): t=solid_tones(hexc,seed); return cube(t,t,t)
    icons["grass_block"]  = cube(grass_top(1), grass_side(2), grass_side(3))
    icons["stone"]        = b1("#8f8f8f", 10)
    icons["cobblestone"]  = (lambda: (lambda t: cube(t,t,t))(noisy(A("#8a8a8a"),[A("#6f6f6f"),A("#a5a5a5"),A("#5a5a5a")],12,[6,3,3,3])))()
    icons["dirt"]         = b1("#8a6a43", 14)
    icons["oak_planks"]   = (lambda t: cube(t,t,t))(planks("#b48a50", 16))
    icons["diamond_block"]= b1("#4fd6cf", 18)
    icons["gold_block"]   = b1("#f4cf45", 20)
    icons["iron_block"]   = b1("#d8d8d8", 22)
    icons["emerald_block"]= b1("#3fbf6a", 24)
    icons["netherite_block"]=(lambda t: cube(t,t,t))(speckled("#4a4148","#6a5b52",26))
    icons["redstone_block"]= b1("#b0281f", 28)
    icons["lapis_block"]  = b1("#2b4fb0", 30)
    icons["obsidian"]     = (lambda t: cube(t,t,t))(speckled("#1a1424","#3a2c53",32))
    icons["end_stone"]    = (lambda t: cube(t,t,t))(noisy(A("#e5e6b8"),[A("#d5d69f"),A("#c7c98a"),A("#f0f0d2")],34,[7,3,3,2]))
    icons["purpur_block"] = (lambda t: cube(t,t,t))(noisy(A("#a568a8"),[A("#8f5591"),A("#b87fbb")],36))
    icons["bricks"]       = (lambda t: cube(t,t,t))(bricks(38))
    icons["glowstone"]    = (lambda t: cube(t,t,t))(speckled("#c79a3a","#ffe07a",40))
    icons["diamond_ore"]  = (lambda t: cube(t,t,t))(speckled("#8f8f8f","#4fd6cf",42))
    icons["netherrack"]   = (lambda t: cube(t,t,t))(noisy(A("#6e2b2b"),[A("#571f1f"),A("#843737")],44))
    icons["tnt"]          = cube(tnt_top(46), tnt_side(47), tnt_side(48))
    icons["crafting_table"]= cube(crafting_top(50), crafting_side(51), crafting_side(52))
    icons["furnace"]      = cube(solid_tones("#8a8a8a",54), furnace_front(55), furnace_side(56))
    icons["bookshelf"]    = cube(planks("#b48a50",58), bookshelf_side(59), bookshelf_side(60))
    # flat items
    icons["diamond"]      = gem("#4fd6cf", 70)
    icons["emerald"]      = gem("#3fbf6a", 71)
    icons["gold_ingot"]   = ingot("#f4cf45", 72)
    icons["iron_ingot"]   = ingot("#d8d8d8", 73)
    icons["netherite_ingot"]= ingot("#6a5b52", 74)
    icons["nether_star"]  = nether_star()
    icons["ender_eye"]    = ender_eye()
    icons["diamond_sword"]= diamond_sword()
    icons["compass"]      = compass()
    icons["apple"]        = apple("#c0392b", 76)
    icons["golden_apple"] = apple("#f4cf45", 77)
    return icons

if __name__ == "__main__":
    icons = build()
    for name, img in icons.items():
        img.save(os.path.join(OUT, name + ".png"))
    print(f"wrote {len(icons)} item icons to {OUT}")
    # montage for review
    cols = 8; rows = (len(icons)+cols-1)//cols
    sheet = Image.new("RGBA", (cols*N, rows*N), (18,16,31,255))
    for i,(name,img) in enumerate(icons.items()):
        sheet.alpha_composite(img, ((i%cols)*N, (i//cols)*N))
    sheet.save(os.path.join(os.path.dirname(__file__), "..", "scratchpad", "items_sheet.png"))
    print("catalogue:", ", ".join(icons.keys()))
