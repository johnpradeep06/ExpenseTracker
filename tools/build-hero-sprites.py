"""Builds the animated sprite sheets for the heroes (public/heroes/<id>-sprite.webp).
Each sheet is 8 frames across x 5 animations down: idle, power, hit, cheer, sleep. The pig is warped piece by piece
(head, arms, cape, tail, jets) so the limbs really move. Run: python3 tools/build-hero-sprites.py <cutout-dir> <out-dir>
Cutouts are 800px transparent PNGs named <id>.png. Needs Pillow and numpy."""
import sys, math, numpy as np
from PIL import Image

F = 256          # frame size
COLS, ROWS = 8, 5
# Points are fractions of a 400px square cell the (aspect-preserved, centred) picture sits in.
HEROES = {
 'captain-penny': dict(head=((.5,.27),.30,(.5,.44)), arms=[dict(p=(.62,.52),t=(.82,.56),pw=1), dict(p=(.28,.58),t=(.30,.72))], extras=[((.12,.55),.17,6,'x')]),
 'loki-pig':      dict(head=((.5,.30),.30,(.5,.48)), arms=[dict(p=(.62,.62),t=(.75,.50),pw=1), dict(p=(.38,.70),t=(.30,.80))], extras=[((.25,.78),.22,5,'x')]),
 'gadget-penny':  dict(head=((.44,.30),.21,(.44,.45)), arms=[dict(p=(.58,.43),t=(.76,.33),pw=1), dict(p=(.34,.45),t=(.24,.46))], extras=[((.34,.90),.10,4,'y'),((.66,.90),.10,4,'y')]),
 'widow-sow':     dict(head=((.55,.35),.28,(.55,.55)), arms=[dict(p=(.74,.52),t=(.90,.38),pw=1), dict(p=(.30,.62),t=(.12,.52))], extras=[((.08,.20),.16,7,'x')]),
 'panther-pig':   dict(head=((.5,.48),.30,(.5,.62)), arms=[dict(p=(.70,.66),t=(.90,.86),pw=1), dict(p=(.40,.66),t=(.33,.80))], extras=[((.07,.27),.13,7,'x')]),
 'doctor-swine':  dict(head=((.5,.22),.21,(.5,.40)), arms=[dict(p=(.33,.55),t=(.14,.36),pw=1), dict(p=(.66,.60),t=(.80,.52))], extras=[((.5,.86),.30,5,'x')]),
 'thunder-pork':  dict(head=((.46,.36),.21,(.46,.52)), arms=[dict(p=(.72,.58),t=(.86,.36),pw=1), dict(p=(.40,.70),t=(.36,.80))], extras=[((.12,.55),.14,5,'x'),((.10,.84),.20,5,'x')]),
 'hulk-hog':      dict(head=((.5,.20),.17,(.5,.34)), arms=[dict(p=(.70,.36),t=(.84,.17),pw=1), dict(p=(.30,.36),t=(.16,.17))], extras=[]),
}

def smooth(t): t = np.clip(t, 0, 1); return 1 - (3*t*t - 2*t*t*t)

def render(img, spec, cell_map, g, parts):
    """img: float RGBA premultiplied (F,F,4). g: dict global (dx,dy,sx,sy,rot). parts: list of (kind, params)."""
    H, W = img.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    fx, fy = g['fx'], g['fy']
    # undo global (about the feet): translate, rotate, scale
    x = xx - g['dx'] - fx; y = yy - g['dy'] - fy
    c, s = math.cos(-g['rot']), math.sin(-g['rot'])
    x, y = c*x - s*y, s*x + c*y
    x /= g['sx']; y /= g['sy']
    x += fx; y += fy
    sx_, sy_ = x.copy(), y.copy()
    for kind, P in parts:
        if kind == 'rot':     # rotate a region around a pivot
            (px, py), (cx, cy), r, ang = P
            d = np.hypot(x - cx, y - cy); w = smooth(d / r)
            a = -ang * w
            ca, sa = np.cos(a), np.sin(a)
            rx, ry = x - px, y - py
            sx_ += (ca*rx - sa*ry + px) - x
            sy_ += (sa*rx + ca*ry + py) - y
        elif kind == 'wave':  # flutter a region
            (cx, cy), r, amp, axis, ph = P
            d = np.hypot(x - cx, y - cy); w = smooth(d / r)
            off = amp * np.sin(ph + d / r * 2.2) * w
            if axis == 'x': sx_ += off
            else: sy_ += off
    # bilinear sample
    x0 = np.clip(np.floor(sx_).astype(int), 0, W-2); y0 = np.clip(np.floor(sy_).astype(int), 0, H-2)
    tx = np.clip(sx_ - x0, 0, 1)[..., None]; ty = np.clip(sy_ - y0, 0, 1)[..., None]
    out = (img[y0, x0]*(1-tx)*(1-ty) + img[y0, x0+1]*tx*(1-ty) + img[y0+1, x0]*(1-tx)*ty + img[y0+1, x0+1]*tx*ty)
    inside = ((sx_ >= 0) & (sx_ <= W-1) & (sy_ >= 0) & (sy_ <= H-1))[..., None]
    return out * inside

def build(name, cut_dir, out_dir):
    spec = HEROES[name]
    src = Image.open(f'{cut_dir}/{name}.png').convert('RGBA')
    src = src.crop(src.getbbox())
    # picture box inside the frame: fit 190px, centred, feet near the bottom
    sc = 216 / max(src.size); iw, ih = round(src.width*sc), round(src.height*sc)
    pic = src.resize((iw, ih), Image.LANCZOS)
    left, top = (F - iw)//2, F - 10 - ih
    canvas = Image.new('RGBA', (F, F), (0, 0, 0, 0)); canvas.paste(pic, (left, top))
    a = np.asarray(canvas).astype(np.float32) / 255
    a[..., :3] *= a[..., 3:4]  # premultiply
    # cell (400px) -> frame px
    s400 = 400 / max(src.size); w4, h4 = src.width*s400, src.height*s400; ox, oy = (400-w4)/2, (400-h4)/2
    def P(pt): return (left + ((pt[0]*400 - ox)/w4)*iw, top + ((pt[1]*400 - oy)/h4)*ih)
    R = lambda r: r * 400 / w4 * iw     # radius in frame px
    head_c, head_r, neck = spec['head']; hc, hr, nk = P(head_c), R(head_r), P(neck)
    arms = [(P(a_['p']), P(a_['t'])) for a_ in spec['arms']]
    extras = [(P(c), R(r), amp, ax) for c, r, amp, ax in spec['extras']]
    fx, fy = F/2, top + ih          # feet pivot
    D = math.radians
    def arm_part(i, ang):
        p, t = arms[i]; cx, cy = (p[0]+t[0])/2, (p[1]+t[1])/2
        L = math.hypot(t[0]-p[0], t[1]-p[1])
        sign = 1 if t[0] > p[0] else -1   # raising = rotating tip upward
        return ('rot', (p, (cx, cy), L*0.62 + 4, -sign*D(ang)))
    def head_part(ang): return ('rot', (nk, hc, hr*1.15, D(ang)))
    def flutter(ph, k=1.0): return [('wave', (c, r, amp*k, ax, ph)) for c, r, amp, ax in extras]
    def G(dx=0, dy=0, sx=1, sy=1, rot=0): return dict(dx=dx, dy=dy, sx=sx, sy=sy, rot=D(rot), fx=fx, fy=fy)
    N = COLS
    frames = []
    for anim in range(ROWS):
        row = []
        for f in range(N):
            t = f / N; ph = 2*math.pi*t
            if anim == 0:   # idle loop
                b = math.sin(ph)
                g = G(0, 0, 1 - .012*b, 1 + .03*b, 1.2*math.sin(ph))
                parts = [head_part(3*math.sin(ph + .6)), arm_part(1, 5*math.sin(ph + 1.2)), arm_part(0, 4*math.sin(ph))] + flutter(ph)
            elif anim == 1: # power: anticipate, strike, hold, recover
                keys = [0, .15, .4, 1.0, 1.0, .7, .3, 0]
                k = keys[f]; wind = [0, 1, 0, 0, 0, 0, 0, 0][f]
                ang = 75*k - 25*wind
                g = G(8*k, -22*k + 8*wind, 1 + .05*wind - .03*k, 1 - .1*wind + .05*k, 8*k - 6*wind)
                parts = [arm_part(0, ang), arm_part(1, 20*k), head_part(-6*k)] + flutter(ph*2, 1.6)
            elif anim == 2: # hit: recoil and shake
                keys = [0, 1, .9, .6, .8, .3, .1, 0]; k = keys[f]
                g = G(-10*k*math.cos(ph), 2*k, 1 + .05*k, 1 - .06*k, -12*k)
                parts = [head_part(14*math.sin(ph*3)*k), arm_part(0, 40*k), arm_part(1, 40*k)] + flutter(ph*3, 1.2*k + .3)
            elif anim == 3: # cheer: jump with both arms up
                keys = [0, .35, 1, .6, 0, -.2, 0, 0]; j = keys[f]
                squash = [1, 1, 0, 0, 0, 1, .4, 0][f]
                g = G(0, -34*max(j, 0), 1 + .08*squash - .03*max(j, 0), 1 - .12*squash + .05*max(j, 0), 4*math.sin(ph*2))
                up = [0, 20, 70, 80, 60, 20, 10, 0][f]
                parts = [arm_part(0, up), arm_part(1, up), head_part(5*math.sin(ph*2))] + flutter(ph*2, 1.6)
            else:           # sleep / sad: slump and slow breath
                b = math.sin(ph)
                g = G(0, 3, 1.03 - .01*b, .95 + .015*b, 3)
                parts = [head_part(18 + 2*b), arm_part(0, -14), arm_part(1, -14)] + flutter(ph*.5, .3)
            row.append(render(a, spec, None, g, parts))
        frames.append(row)
    sheet = np.zeros((ROWS*F, COLS*F, 4), np.float32)
    for r in range(ROWS):
        for c in range(COLS): sheet[r*F:(r+1)*F, c*F:(c+1)*F] = frames[r][c]
    al = sheet[..., 3:4]; rgb = np.where(al > 1e-4, sheet[..., :3] / np.maximum(al, 1e-4), 0)
    out = np.dstack([rgb, al]).clip(0, 1)
    im = Image.fromarray((out*255).astype(np.uint8), 'RGBA').resize((COLS*192, ROWS*192), Image.LANCZOS)  # 192px frames keep the sheets small
    im.save(f'{out_dir}/{name}-sprite.webp', quality=62, method=6)
    return sheet

if __name__ == '__main__':
    cut, out = sys.argv[1], sys.argv[2]
    for n in (sys.argv[3:] or HEROES): build(n, cut, out); print('built', n)
