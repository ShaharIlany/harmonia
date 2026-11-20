"""Round 2, v3: the three concepts to show, plus the Harmonia wordmark for the lockups."""
import math, importlib.util
spec = importlib.util.spec_from_file_location("c", "make-concepts.py"); c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
f, P, svg, write, circle, lyre = c.f, c.P, c.svg, c.write, c.circle, c.lyre
K = "#000000"

def bubble(cx, cy, r, tail=125, spread=24, tip_r=1.62):
    a1, a2 = P(cx, cy, r, tail - spread), P(cx, cy, r, tail + spread); tip = P(cx, cy, r * tip_r, tail + 4)
    return f"M{f(*a2)} L{f(*tip)} L{f(*a1)} A{f(r, r)} 0 1 0 {f(*a2)} Z"

# A: H with a message for a bar. Stems 50 wide (r=25); a pill bubble between them with 10-unit gaps, a little above centre.
def h_bar(col=K):
    stems = "".join(f'<rect x="{x}" y="34" width="50" height="188" rx="25" fill="{col}"/>' for x in (36, 170))
    pill = f'<rect x="96" y="94" width="64" height="52" rx="26" fill="{col}"/>'
    tail = f'<path fill="{col}" d="M104 132 L98 170 L128 144 Z"/>'
    return stems + pill + tail

# C: Chord. A bubble with three holes rising like the notes of a chord (do-mi-sol), each step 36 across and 22 up.
def chord(col=K, cx=128, cy=120, r=88):
    holes = " ".join(circle(cx + k * 36, cy + 4 - k * 22, 15) for k in (-1, 0, 1))
    return f'<path fill="{col}" fill-rule="evenodd" d="{bubble(cx, cy, r)} {holes}"/>'

# Wordmark "harmonia"? No: "Harmonia", capital H. Monoline, stroke 22, round caps, bowls r=31, same system as the Team Chat
# wordmark (x-height 115..177, caps from 71). Stroke-centre positions worked out from ink gaps: 26 straight-straight,
# 22 straight-round, 16 after the open r.
SW = 22
def wordmark(x0=0, col=K):
    def ring(cx): return f"M{f(cx + 31)} 146 A31 31 0 1 1 {f(cx - 31)} 146 A31 31 0 1 1 {f(cx + 31)} 146"
    def a(cx): return ring(cx) + f" M{f(cx + 31)} 115 V177"
    X = lambda v: x0 + v
    d = [f"M{f(X(11))} 71 V177 M{f(X(91))} 71 V177 M{f(X(11))} 122 H{f(X(91))}",          # H
         a(X(155)),                                                                       # a
         f"M{f(X(234))} 177 V137 A22 22 0 0 1 {f(X(256))} 115 H{f(X(262))}",              # r
         f"M{f(X(300))} 177 V137 A22 22 0 0 1 {f(X(344))} 137 V177 M{f(X(344))} 137 A22 22 0 0 1 {f(X(388))} 137 V177",  # m
         ring(X(452)),                                                                    # o
         f"M{f(X(527))} 177 V137 A22 22 0 0 1 {f(X(571))} 137 V177",                       # n
         f"M{f(X(619))} 115 V177 M{f(X(619))} 80 V80",                                     # i
         a(X(694))]                                                                       # a
    return (f'<path fill="none" stroke="{col}" stroke-width="{SW}" stroke-linecap="round" stroke-linejoin="round" '
            f'd="{" ".join(d)}"/>'), x0 + 736

if __name__ == "__main__":
    marks = {"a-h-bar": h_bar(), "b-lyre": lyre(), "c-chord": chord()}
    for n, body in marks.items():
        write(f"{n}.svg", svg(body))
        wm, right = wordmark(296)
        write(f"{n}-lockup.svg", svg(body + wm, right + 8))
    wm, right = wordmark(0)
    write("wordmark.svg", svg(wm, right + 8))
    write("a-h-bar-color.svg", svg(h_bar("#E0583A")))
    write("b-lyre-color.svg", svg(lyre(colour=True)))
    write("c-chord-color.svg", svg(chord("#E0583A")))
