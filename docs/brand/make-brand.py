#!/usr/bin/env python3
"""Writes the Harmonia brand SVG masters into this folder. No dependencies: python3 make-brand.py

The mark ("Lyre"): harmonia first meant tuning a lyre's strings to each other. Six strings, one per teammate, in the
starter teammates' colours; the frame is graphite on light backgrounds and white on dark ones. Nothing else has colour.
Canvas 256 x 256. Two horn arms (stroke 16, about Poppins Medium's stem) rise from a sound box (x 58-198, y 194-214) and
curl out at the top; a yoke across them at y 84; six strings (5 wide) from the yoke to the box, centred 94 to 162.
The small cut (16-32 px) has a heavier frame (24) and wider strings (9), so the colour still reads.
The wordmark is Poppins Medium, outlined into wordmark-poppins.json by outline-wordmark.swift.
macapp/make-icon.swift draws the app icon from the same numbers.
"""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
INK, WHITE = "#202328", "#FFFFFF"  # graphite
# The starter teammates' colours, left to right in roster order: Dali, Leo, Elliot, Sherlock, Murphy, Emily.
TEAM = ["#EAB308", "#3B82F6", "#22C55E", "#A855F7", "#EF4444", "#06B6D4"]

def f(*p): return " ".join(f"{v:.2f}".rstrip("0").rstrip(".") for v in p)

ARM = "M80 196 C62 164 56 120 66 84 C72 64 64 48 50 42"  # the left arm; the right one is its mirror
def mirror(d):
    toks, out, i = re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?", d), [], 0
    while i < len(toks):
        if toks[i].isalpha(): out.append(toks[i]); i += 1
        else: out.append(f(256 - float(toks[i]), float(toks[i + 1]))); i += 2
    return " ".join(out)

def mark(frame=INK, strings=TEAM, small=False, tx=0, ty=0, s=1.0):
    """The lyre. `strings`: a list of six colours, or one colour for all."""
    cols = strings if isinstance(strings, list) else [strings] * 6
    sw, s_w, x0, x1 = (24, 9, 89, 167) if small else (16, 5, 94, 162)
    yoke_y, box = 84, (58, 194, 20)
    out = []
    for k, c in enumerate(cols):
        x = x0 + k * (x1 - x0) / 5
        out.append(f'<rect x="{f(x - s_w / 2)}" y="{yoke_y}" width="{s_w}" height="{box[1] - yoke_y + 2}" rx="{f(s_w / 2)}" fill="{c}"/>')
    out.append(f'<path fill="none" stroke="{frame}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round" '
               f'd="{ARM} {mirror(ARM)} M54 {yoke_y} H202"/>')
    out.append(f'<rect x="{box[0]}" y="{box[1]}" width="{256 - 2 * box[0]}" height="{box[2]}" rx="{box[2] / 2}" fill="{frame}"/>')
    body = "".join(out)
    return f'<g transform="translate({f(tx, ty)}) scale({f(s)})">{body}</g>' if (tx or ty or s != 1) else body

# Wordmark: "Harmonia" in Poppins Medium (Google Fonts, SIL Open Font License), outlined so no file needs the font.
# Cap height 106 on the 256 canvas, baseline at 180. To redo it: swift outline-wordmark.swift > wordmark-poppins.json
WORDMARK = json.load(open(os.path.join(HERE, "wordmark-poppins.json")))
def wordmark(x0, colour):
    """The outlined wordmark with its left edge at x0. Returns the path and its right edge."""
    dx = x0 - WORDMARK["left"]
    return (f'<path fill="{colour}" transform="translate({f(dx)} 0)" d="{WORDMARK["d"]}"/>',
            x0 + WORDMARK["right"] - WORDMARK["left"])

def svg(body, w, title, h=256):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f(w)} {f(h)}" width="{f(w)}" height="{f(h)}" '
            f'role="img"><title>{title}</title>{body}</svg>\n')

def write(name, text):
    with open(os.path.join(HERE, name), "w") as fh: fh.write(text)
    print("wrote", name)

def app_icon(small=False):
    # macOS grid on a 1024 canvas: an 824 rounded square inset 100, radius 185, the mark at scale 2.9.
    # The 16 and 32 px cut fills more of the canvas (inset 40, radius 220) with the small mark at scale 3.5.
    inset, radius, scale = (40, 220, 3.5) if small else (100, 185, 2.9)
    side = 1024 - 2 * inset
    off = 512 - 128 * scale
    g = (f'<defs><linearGradient id="tile" x1="0" y1="{inset}" x2="0" y2="{1024 - inset}" gradientUnits="userSpaceOnUse">'
         '<stop offset="0" stop-color="#2E3036"/><stop offset="1" stop-color="#141518"/></linearGradient></defs>'
         f'<rect x="{inset}" y="{inset}" width="{side}" height="{side}" rx="{radius}" fill="url(#tile)"/>')
    return svg(g + mark(WHITE, small=small, tx=off, ty=off, s=scale), 1024, "Harmonia app icon", 1024)

def favicon():
    """The small cut whose frame follows the browser: graphite in light mode, white in dark mode."""
    body = mark(frame="FRAME", small=True).replace('stroke="FRAME"', 'class="fs"').replace('fill="FRAME"', 'class="ff"')
    style = (f"<style>.fs{{stroke:{INK}}}.ff{{fill:{INK}}}"
             f"@media (prefers-color-scheme:dark){{.fs{{stroke:{WHITE}}}.ff{{fill:{WHITE}}}}}</style>")
    return svg(style + body, 256, "Harmonia")

if __name__ == "__main__":
    write("mark.svg", svg(mark(), 256, "Harmonia"))
    write("mark-reversed.svg", svg(mark(WHITE), 256, "Harmonia (on dark)"))
    write("mark-small.svg", svg(mark(small=True), 256, "Harmonia (small sizes)"))
    write("mark-small-reversed.svg", svg(mark(WHITE, small=True), 256, "Harmonia (small sizes, on dark)"))
    write("favicon.svg", favicon())
    write("mark-black.svg", svg(mark("#000000", "#000000"), 256, "Harmonia"))
    write("mark-white.svg", svg(mark(WHITE, WHITE), 256, "Harmonia"))
    write("mark-ink.svg", svg(mark(INK, INK), 256, "Harmonia"))
    for name, col in (("", INK), ("-white", WHITE)):
        wm, right = wordmark(288, col)
        write(f"lockup{name}.svg", svg(mark(col) + wm, right + 8, "Harmonia"))
        wm0, right0 = wordmark(8, col)
        write(f"wordmark{name}.svg", svg(wm0, right0 + 8, "Harmonia"))
    # Stacked: the mark above the wordmark, centred.
    wm, right = wordmark(0, INK)
    w = right
    write("lockup-stacked.svg", svg(mark(tx=(w - 256) / 2, ty=0) + f'<g transform="translate(0 236)">{wm}</g>', w, "Harmonia", 256 + 236 - 40))
    write("app-icon.svg", app_icon())
    write("app-icon-small.svg", app_icon(small=True))
