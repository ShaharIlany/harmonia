#!/usr/bin/env python3
"""Writes the Team Chat brand SVG masters into this folder. No dependencies: python3 make-brand.py

The mark ("Table"): your message bubble in the middle, the six teammates around it.
Canvas 256 x 256. Bubble r=50 at (128,128), tail toward 125 deg. Six dots r=21 on a ring r=100, every 60 deg from the top.
The small cut (16-32 px) uses bigger dots (r=27) and a bigger bubble (r=56) so the gaps stay open.
macapp/make-icon.swift draws the app icon from the same numbers.
"""
import math, os

HERE = os.path.dirname(os.path.abspath(__file__))
INK, CORAL, WHITE = "#2A211E", "#E0583A", "#FFFFFF"
# Teammate colours, clockwise from the top. Red sits away from the coral bubble's tail.
DOTS = ["#EAB308", "#22C55E", "#06B6D4", "#3B82F6", "#A855F7", "#EF4444"]
ANGLES = [-90, -30, 30, 90, 150, 210]

def P(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + r * math.cos(a), cy + r * math.sin(a)

def f(*p): return " ".join(f"{v:.2f}".rstrip("0").rstrip(".") for v in p)

def circle(cx, cy, r):
    return f"M{f(cx + r, cy)} A{f(r, r)} 0 1 1 {f(cx - r, cy)} A{f(r, r)} 0 1 1 {f(cx + r, cy)} Z"

def bubble(cx, cy, r, tail=125, spread=24, tip_r=1.76):
    """A circle with a tail: the tail's two edges leave the circle at tail +/- spread and meet at the tip."""
    a1, a2 = P(cx, cy, r, tail - spread), P(cx, cy, r, tail + spread)
    tip = P(cx, cy, r * tip_r, tail + 4)
    return f"M{f(*a2)} L{f(*tip)} L{f(*a1)} A{f(r, r)} 0 1 0 {f(*a2)} Z"

def mark(cx=128, cy=128, s=1.0, small=False, bubble_fill=CORAL, dot_fills=DOTS):
    br, dr, ring = (56, 27, 98) if small else (50, 21, 100)
    out = [f'<path fill="{bubble_fill}" d="{bubble(cx, cy, br * s)}"/>']
    for a, c in zip(ANGLES, dot_fills if isinstance(dot_fills, list) else [dot_fills] * 6):
        x, y = P(cx, cy, ring * s, a)
        out.append(f'<path fill="{c}" d="{circle(x, y, dr * s)}"/>')
    return "".join(out)

# Wordmark "Team Chat": monoline, round caps, stroke 22, built on circles r=31 (x-height 84, cap height 128).
SW = 22
def wordmark(x0, colour):
    base, xc = 177, 146  # stroke centre line of the baseline, bowl centre
    def ring(cx): return f"M{f(cx + 31, xc)} A31 31 0 1 1 {f(cx - 31, xc)} A31 31 0 1 1 {f(cx + 31, xc)}"
    def a(cx): return ring(cx) + f" M{f(cx + 31, 115)} V{base}"
    d = []
    x = x0
    d.append(f"M{f(x + 11, 71)} H{f(x + 91)} M{f(x + 51, 71)} V{base}")                     # T
    cx = x + 132
    e_end = P(cx, xc, 31, 42)
    d.append(f"M{f(cx - 31, xc)} H{f(cx + 31)} A31 31 0 1 0 {f(*e_end)}")                    # e
    cx += 100; d.append(a(cx))                                                              # a
    m = cx + 69
    d.append(f"M{f(m, base)} V137 A22 22 0 0 1 {f(m + 44)} 137 V{base} M{f(m + 44)} 137 A22 22 0 0 1 {f(m + 88)} 137 V{base}")  # m
    ccx = m + 88 + 11 + 44 + 64
    c1, c2 = P(ccx, 124, 53, -42), P(ccx, 124, 53, 42)
    d.append(f"M{f(*c1)} A53 53 0 1 0 {f(*c2)}")                                            # C
    h = c1[0] + 11 + 16 + 11 + 2
    d.append(f"M{f(h, 71)} V{base} M{f(h)} 137 A22 22 0 0 1 {f(h + 44)} 137 V{base}")       # h
    cx = h + 44 + 11 + 16 + 42; d.append(a(cx))                                             # a
    t = cx + 31 + 11 + 14 + 31
    d.append(f"M{f(t, 82)} V{f(base - 18)} A18 18 0 0 0 {f(t + 18, base)} M{f(t - 20, 115)} H{f(t + 22)}")  # t
    right = t + 22 + 11
    path = (f'<path fill="none" stroke="{colour}" stroke-width="{SW}" stroke-linecap="round" '
            f'stroke-linejoin="round" d="{" ".join(d)}"/>')
    return path, right

def svg(body, w, title, h=256):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f(w)} {h}" width="{f(w)}" height="{h}" '
            f'role="img"><title>{title}</title>{body}</svg>\n')

def write(name, text):
    with open(os.path.join(HERE, name), "w") as fh: fh.write(text)
    print("wrote", name)

def app_icon(small=False):
    # macOS grid on a 1024 canvas: an 824 rounded square inset 100, radius 185, the mark at scale 2.2.
    # The 16 and 32 px cut fills more of the canvas (inset 40, radius 220) with the small mark at scale 3.
    inset, radius, scale = (40, 220, 3.0) if small else (100, 185, 2.2)
    side = 1024 - 2 * inset
    g = (f'<defs><linearGradient id="tile" x1="0" y1="{inset}" x2="0" y2="{1024 - inset}" gradientUnits="userSpaceOnUse">'
         '<stop offset="0" stop-color="#3A2D28"/><stop offset="1" stop-color="#211A17"/></linearGradient></defs>'
         f'<rect x="{inset}" y="{inset}" width="{side}" height="{side}" rx="{radius}" fill="url(#tile)"/>')
    return svg(g + mark(512, 512, scale, small=small), 1024, "Team Chat app icon", 1024)

if __name__ == "__main__":
    write("mark.svg", svg(mark(), 256, "Team Chat"))
    write("mark-small.svg", svg(mark(small=True), 256, "Team Chat (small sizes)"))
    write("mark-black.svg", svg(mark(bubble_fill="#000000", dot_fills="#000000"), 256, "Team Chat"))
    write("mark-white.svg", svg(mark(bubble_fill=WHITE, dot_fills=WHITE), 256, "Team Chat"))
    write("mark-coral.svg", svg(mark(bubble_fill=CORAL, dot_fills=CORAL), 256, "Team Chat"))
    for name, col in (("", INK), ("-white", WHITE)):
        wm, right = wordmark(292, col)
        write(f"lockup{name}.svg", svg(mark() + wm, right + 8, "Team Chat"))
        wm0, right0 = wordmark(0, col)
        write(f"wordmark{name}.svg", svg(f'<g transform="translate(-11 0)">{wm0}</g>', right0 - 11 + 8 - 11, "Team Chat"))
    write("app-icon.svg", app_icon())
    write("app-icon-small.svg", app_icon(small=True))
