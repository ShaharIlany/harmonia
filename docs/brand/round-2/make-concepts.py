#!/usr/bin/env python3
"""Round 2: three concepts for Harmonia, black first. python3 make-concepts.py
A "Orchestra": your message bubble at the podium, six teammates seated in an arc around it.
B "Lyre": harmonia first meant tuning a lyre's strings to each other; six strings, six teammates.
C "Two voices": an H made of two speech bubbles held together by the bar.
"""
import math, os
HERE = os.path.dirname(os.path.abspath(__file__))
INK = "#000000"
DOTS = ["#EAB308", "#22C55E", "#06B6D4", "#3B82F6", "#A855F7", "#EF4444"]

def P(cx, cy, r, deg):
    a = math.radians(deg); return cx + r * math.cos(a), cy + r * math.sin(a)
def f(*p): return " ".join(f"{v:.2f}".rstrip("0").rstrip(".") for v in p)
def circle(cx, cy, r): return f"M{f(cx + r, cy)} A{f(r, r)} 0 1 1 {f(cx - r, cy)} A{f(r, r)} 0 1 1 {f(cx + r, cy)} Z"
def bubble(cx, cy, r, tail=125, spread=24, tip_r=1.76):
    a1, a2 = P(cx, cy, r, tail - spread), P(cx, cy, r, tail + spread); tip = P(cx, cy, r * tip_r, tail + 4)
    return f"M{f(*a2)} L{f(*tip)} L{f(*a1)} A{f(r, r)} 0 1 0 {f(*a2)} Z"
def svg(body, w=256, h=256, title="Harmonia"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f(w)} {f(h)}" width="{f(w)}" height="{f(h)}" role="img"><title>{title}</title>{body}</svg>\n'
def write(name, text):
    open(os.path.join(HERE, name), "w").write(text); print("wrote", name)

# A: Orchestra. Bubble r=44 at the podium; six dots r=19 on an arc r=96 from 180 to 360 deg (behind it, like players).
def orchestra(colour=False, dy=-3):
    cx, cy = 128, 150 + dy
    out = [f'<path fill="{"#E0583A" if colour else INK}" d="{bubble(cx, cy, 44)}"/>']
    for i, a in enumerate(range(180, 361, 36)):
        x, y = P(cx, cy, 96, a)
        out.append(f'<path fill="{DOTS[i] if colour else INK}" d="{circle(x, y, 19)}"/>')
    return "".join(out)

# B: Lyre. Two horn arms (stroke 20) rising from a sound box, a yoke across the top, six strings between.
def lyre(colour=False, strings=6, sw=6):
    frame = "#E0583A" if colour else INK
    arms = (f'<path fill="none" stroke="{frame}" stroke-width="20" stroke-linecap="round" '
            f'd="M94 196 C44 172 38 96 78 46 M162 196 C212 172 218 96 178 46"/>')
    yoke = f'<path fill="none" stroke="{frame}" stroke-width="16" stroke-linecap="round" d="M54 76 H202"/>'
    box = f'<rect x="70" y="188" width="116" height="28" rx="14" fill="{frame}"/>'
    xs = [128 + (i - (strings - 1) / 2) * (60 / (strings - 1)) for i in range(strings)]
    cols = DOTS if colour and strings == 6 else [INK] * strings
    st = "".join(f'<path fill="none" stroke="{c}" stroke-width="{sw}" stroke-linecap="round" d="M{f(x)} 84 V188"/>' for x, c in zip(xs, cols))
    return arms + yoke + st + box

# C: Two voices. Two pill bubbles (60 wide, r=30) with tails at the outer bottom corners, a bar between them.
def two_voices(colour=False, inward=False):
    c = "#E0583A" if colour else INK
    def pill(x): return f'<rect x="{x}" y="36" width="60" height="170" rx="30" fill="{c}"/>'
    if inward:
        tl = f'<path fill="{c}" d="M100 176 L118 222 L74 203 Z"/>'
        tr = f'<path fill="{c}" d="M156 176 L138 222 L182 203 Z"/>'
    else:
        tl = f'<path fill="{c}" d="M40 176 L22 222 L66 203 Z"/>'
        tr = f'<path fill="{c}" d="M216 176 L234 222 L190 203 Z"/>'
    bar = f'<rect x="96" y="106" width="64" height="34" fill="{c}"/>'
    return pill(40) + pill(156) + tl + tr + bar

if __name__ == "__main__":
    write("a-orchestra.svg", svg(orchestra()))
    write("b-lyre.svg", svg(lyre()))
    write("c-two-voices.svg", svg(two_voices()))
    write("c-two-voices-inward.svg", svg(two_voices(inward=True)))
