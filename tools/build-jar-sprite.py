"""Builds public/jar/jar-sprite.webp from a green-screen clip of a candy jar emptying (25 frames, 5 x 5).
Cleans the cutout: removes the twinkling sparkles (white in one frame but not in the frames around it), fills the
gaps from their surroundings, cuts the green background without a halo, and resizes.
Run: python3 tools/build-jar-sprite.py <clip.mp4> <picks.json> <out.webp>   (picks.json = 25 frame numbers, full -> empty)"""
import sys, json, subprocess, tempfile, os, glob
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

FW, FH = 224, 262
OUTLINE = (34, 66, 52)

def frames_for(clip, numbers, tmp):
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', clip, '-vsync', '0', f'{tmp}/n%04d.png'], check=True)
    return lambda n: Image.open(f'{tmp}/n{n + 1:04d}.png').convert('RGB')

def white(a, thr=225): return a.min(axis=2) > thr

def grow(mask, px):
    im = Image.fromarray((mask * 255).astype('uint8'))
    return np.asarray(im.filter(ImageFilter.MaxFilter(px * 2 + 1))) > 0

def inpaint(a, mask, iters=40):
    """Fill the masked pixels by copying the nearest untouched colour inwards (no blending, so edges stay crisp)."""
    a = a.astype(float); m = mask.copy()
    for _ in range(iters):
        if not m.any(): break
        valid = ~m
        filled = np.zeros(m.shape, bool)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            sv = np.roll(np.roll(valid, dy, 0), dx, 1)
            sa = np.roll(np.roll(a, dy, 0), dx, 1)
            take = m & sv & ~filled
            a[take] = sa[take]
            filled |= take
        m = m & ~filled
    return a

def build(clip, picks, out):
    with tempfile.TemporaryDirectory() as tmp:
        need = set(picks)
        get = frames_for(clip, need, tmp)
        rgba = []; boxes = []
        for p in picks:
            a = np.asarray(get(p)).astype(int)
            far = [np.asarray(get(min(239, max(0, p + d)))).astype(int) for d in (-40, -20, 20, 40)]
            votes_w = sum(white(f, 195).astype(int) for f in far)
            static = grow(votes_w >= 3, 3)
            spark = white(a, 205) & ~static
            m = grow(spark, 7) & (a.min(axis=2) > 135) & ~static
            a = inpaint(a, m).clip(0, 255).astype('uint8')
            im = Image.fromarray(a)
            mk = im.copy()
            for xy in [(0, 0), (1279, 0), (0, 719), (1279, 719), (640, 0), (640, 719), (0, 360), (1279, 360)]:
                try: ImageDraw.floodfill(mk, xy, (255, 0, 255), thresh=60)
                except Exception: pass
            k = np.asarray(mk); bg = (k[..., 0] == 255) & (k[..., 1] == 0) & (k[..., 2] == 255)
            al = Image.fromarray((~bg * 255).astype('uint8'))
            probe = al.copy(); ImageDraw.floodfill(probe, (640, 420), 128)
            hard = (np.asarray(probe) == 128)
            rgba.append((np.asarray(im).copy(), hard))
        # The jar never moves, so its outline is the same in every frame. Take the shape most frames agree on:
        # sparkles that stick out past the rim differ from frame to frame and disappear.
        votes = np.mean([h for _, h in rgba], axis=0)
        shape = Image.fromarray(((votes > 0.5) * 255).astype('uint8')).filter(ImageFilter.MinFilter(3))
        core = np.asarray(shape.filter(ImageFilter.MinFilter(5))) > 127
        soft = np.asarray(shape.filter(ImageFilter.GaussianBlur(1.0)))
        boxes = [shape.getbbox()]
        ys = np.where(np.asarray(shape).any(axis=1))[0]
        lid_to = int(ys[0] + 0.30 * (ys[-1] - ys[0]))
        stack = np.stack([r[:lid_to] for r, _ in rgba]).astype(int)          # frames x rows x cols x 3
        rank = np.argsort(stack.sum(axis=3), axis=0)[len(rgba) // 4]          # the frame at the 25th percentile of brightness, per pixel
        plate = np.take_along_axis(stack, rank[None, ..., None].repeat(3, axis=3), axis=0)[0].astype('uint8')
        cleaned = []
        for rgb, _ in rgba:
            rgb = rgb.copy()
            rgb[:lid_to] = plate
            rgb[~core] = OUTLINE       # the edge and everything outside is the outline colour, so no green fringe survives
            cleaned.append((rgb, soft))
        rgba = cleaned
        x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes); x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
        h = FH; w = int(round(h * (x1 - x0) / (y1 - y0)))
        w = min(w, FW)
        cols = 5
        sheet = Image.new('RGBA', (cols * FW, cols * FH), (0, 0, 0, 0))
        for i, (rgb, soft) in enumerate(rgba):
            fr = Image.fromarray(np.dstack([rgb, soft]).astype('uint8'), 'RGBA').crop((x0, y0, x1, y1)).resize((w, h), Image.LANCZOS)
            sheet.paste(fr, ((i % cols) * FW + (FW - w) // 2, (i // cols) * FH))
        sheet.save(out, quality=86, method=6)
        return sheet.size, os.path.getsize(out)

if __name__ == '__main__':
    print(build(sys.argv[1], json.load(open(sys.argv[2])), sys.argv[3]))
