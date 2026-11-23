#!/usr/bin/env python3
"""Writes the Harmonia brand SVG masters into this folder, and the favicon and sidebar mark into public/index.html.
No dependencies: python3 make-brand.py

The mark ("Lyre"): harmonia first meant tuning a lyre's strings to each other. A solid lyre whose horns curl out into a
beak at the top and whose sound box comes to a point at the bottom, with six strings, red to violet, fanning out a little
as they fall into the box. White on dark, graphite on light; the strings are the only colour. Traced from the artwork
picked on 2026-11-23: the outline is twelve cubic curves for the left half (LEFT), mirrored about x = 128.
Canvas 256 x 256: the lyre spans x 41.2-214.8, y 38.6-218. Strings 5.2 wide from y 65 down under the box (y 189).
The small cut (16-32 px) thickens the outline with a 6-unit stroke and widens the strings to 9, so the colour still reads.
The artwork (artwork.svg) and the app icon add a navy sky, a soft halo and shading; macapp/make-icon.swift draws the
same icon from these numbers.
The wordmark is Poppins Medium, outlined into wordmark-poppins.json by outline-wordmark.swift.
"""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "..", "..", "public", "index.html")
INK, WHITE = "#202328", "#FFFFFF"  # graphite, white
# The strings, left to right: red, orange, yellow, green, blue, violet.
STRINGS = ["#F25165", "#F28E2E", "#F5CA40", "#48DABF", "#4298EF", "#8968F7"]
# Shaded strings (artwork, app icon): deeper at the top, brightest in the middle, darker where they meet the box.
FADE_Y = (63.5, 119.3, 154.2, 178.6)
FADES = [
    ("#EF506A", "#F76C63", "#F06E68", "#E87A74"),
    ("#F2772F", "#F8A639", "#F0A43C", "#DC9240"),
    ("#F1C641", "#F8D04D", "#F2C848", "#D9B243"),
    ("#41D7BB", "#4DDDC4", "#3BC0C2", "#2E9FBB"),
    ("#438CEC", "#42ACF6", "#3F9CEE", "#3A82D6"),
    ("#8963F4", "#8E75F7", "#8F70EF", "#765FD9"),
]
# The lyre's shading (artwork, app icon), top to bottom: warm white at the horns to a cool grey at the point.
BODY = ((0, "#FBF8F1"), (.4, "#F7F3EF"), (.72, "#ECE9EB"), (1, "#E4E2E8"))
# The sky: navy, lighter toward the edges.
SKY = ((0, "#161D38"), (.5, "#171E39"), (.8, "#1F2640"), (1, "#2B3148"))

def f(*p): return " ".join(f"{v:.2f}".rstrip("0").rstrip(".") for v in p)

# The left half of the outline, from the point at the bottom up the outside, round the beak and the knob of the horn,
# down the inside of the arm and along the top of the sound box to the middle. [control 1, control 2, end] per curve.
START = (128, 218.04)
LEFT = [
    [(119.28, 203.98), (106.88, 202.71), (93.64, 198.11)],
    [(68.74, 189.47), (43.18, 168.62), (43.18, 140.38)],
    [(43.18, 122.29), (50.66, 111.54), (59.2, 98.87)],
    [(64.61, 90.83), (70.31, 82.81), (70.31, 72.71)],
    [(70.31, 61.52), (63.76, 54.89), (53.17, 54.89)],    # under the horn
    [(49.36, 54.89), (46.84, 55.4), (42.33, 57.88)],     # to the beak
    [(42.17, 57.22), (41.18, 56.78), (41.18, 53.52)],
    [(41.18, 42.53), (50.65, 38.6), (60.15, 38.6)],      # the top of the knob
    [(76.97, 38.6), (87.66, 50.4), (87.66, 68.52)],
    [(87.66, 79.42), (83.17, 90.6), (78.51, 100.27)],
    [(73.93, 109.75), (67.4, 122.72), (67.4, 133.41)],
    [(67.4, 165.99), (104.8, 181.5), (128.0, 186.88)],   # the top of the sound box, to the middle
]

def curves(first, last):
    """LEFT[first:last] as (start, c1, c2, end) tuples."""
    out, p = [], START
    for k, (c1, c2, e) in enumerate(LEFT):
        if first <= k < last: out.append((p, c1, c2, e))
        p = e
    return out

def mirrored(segs):
    """The same curves on the right, run backwards (so they continue a path that ended at the middle)."""
    m = lambda p: (256 - p[0], p[1])
    return [(m(e), m(c2), m(c1), m(s)) for s, c1, c2, e in reversed(segs)]

def path(segs):
    return f"M{f(*segs[0][0])}" + "".join(f"C{f(*c1)} {f(*c2)} {f(*e)}" for _, c1, c2, e in segs) + "Z"

HALF = curves(0, len(LEFT))
D = path(HALF + mirrored(HALF))                 # the lyre
U = path(curves(8, 12) + mirrored(curves(8, 12)))  # the inside of the U, closed across the tops of the knobs

def string_x(k, y, spread=1.0):
    """Centre of string k (0-5) at height y: they fan out from a point far above the lyre."""
    return 128 + (k - 2.5) * (12.9 + 0.0335 * (y - 128)) * spread
Y0, Y1 = 65.0, 189.0

def lines(strokes, spread=1.0):
    return "".join(f'<line x1="{f(string_x(k, Y0, spread))}" y1="{f(Y0)}" x2="{f(string_x(k, Y1, spread))}" y2="{f(Y1)}" '
                   f'stroke="{c}"/>' for k, c in enumerate(strokes))

def group(body, tx, ty, s):
    return f'<g transform="translate({f(tx, ty)}) scale({f(s)})">{body}</g>' if (tx or ty or s != 1) else body

def mark(frame=INK, strings=STRINGS, small=False, tx=0, ty=0, s=1.0):
    """The flat lyre. `strings`: a list of six colours, or one colour for all."""
    cols = strings if isinstance(strings, list) else [strings] * 6
    sw, spread = (9, 1.15) if small else (5.2, 1.0)
    out = f'<g stroke-width="{f(sw)}" stroke-linecap="round">{lines(cols, spread)}</g>'
    thick = f' stroke="{frame}" stroke-width="6" stroke-linejoin="round"' if small else ""
    out += f'<path fill="{frame}"{thick} d="{D}"/>'
    return group(out, tx, ty, s)

def stops(pairs):
    return "".join(f'<stop offset="{f(o)}" stop-color="{c}"/>' for o, c in pairs)

def shaded(tx=0, ty=0, s=1.0):
    """The lyre as in the artwork: shaded strings and body, a soft halo with a darker gap at the edge. Returns (defs, body)."""
    defs = (f'<linearGradient id="body" gradientUnits="userSpaceOnUse" x1="0" y1="38.6" x2="0" y2="218">{stops(BODY)}</linearGradient>'
            + "".join(f'<linearGradient id="s{k}" gradientUnits="userSpaceOnUse" x1="0" y1="{f(FADE_Y[0])}" x2="0" y2="{f(FADE_Y[-1])}">'
                      + stops(((y - FADE_Y[0]) / (FADE_Y[-1] - FADE_Y[0]), c) for y, c in zip(FADE_Y, cs)) + '</linearGradient>'
                      for k, cs in enumerate(FADES))
            + '<filter id="haloBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9.4"/></filter>'
            + '<filter id="gapBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.9"/></filter>'
            + '<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>'
            # The halo is fainter inside the U.
            + '<mask id="haloMask" maskUnits="userSpaceOnUse" x="-128" y="-128" width="512" height="512">'
              f'<rect x="-128" y="-128" width="512" height="512" fill="#fff"/><path d="{U}" fill-opacity=".6" filter="url(#soft)"/></mask>'
            + f'<path id="lyre" d="{D}"/>')
    body = ('<use href="#lyre" mask="url(#haloMask)" fill="none" stroke="#4A5472" stroke-opacity=".62" stroke-width="51" '
            'stroke-linejoin="round" filter="url(#haloBlur)"/>'
            '<use href="#lyre" fill="none" stroke="#161D38" stroke-opacity=".7" stroke-width="15.4" stroke-linejoin="round" '
            'filter="url(#gapBlur)"/>'
            f'<g stroke-width="5.2" stroke-linecap="round">{lines([f"url(#s{k})" for k in range(6)])}</g>'
            '<use href="#lyre" fill="url(#body)"/>')
    return defs, group(body, tx, ty, s)

def sky(cx, r, clip="", clouds=True):
    """The navy sky with faint clouds toward the edges, on the 1024 canvas. Returns (defs, body)."""
    defs = f'<radialGradient id="sky" cx="{cx}" cy="{cx}" r="{f(r)}" gradientUnits="userSpaceOnUse">{stops(SKY)}</radialGradient>'
    body = f'<rect width="1024" height="1024" fill="url(#sky)"{clip}/>'
    if not clouds:
        return defs, body
    defs += ('<filter id="clouds" x="0" y="0" width="1024" height="1024" filterUnits="userSpaceOnUse">'
            '<feTurbulence type="fractalNoise" baseFrequency=".0055" numOctaves="5" seed="31"/>'
            '<feColorMatrix values="0 0 0 0 .78  0 0 0 0 .81  0 0 0 0 .9  2.6 0 0 0 -1.12"/></filter>'
            f'<radialGradient id="edge" cx="{cx}" cy="{cx}" r="{f(r)}" gradientUnits="userSpaceOnUse">'
            '<stop offset=".4" stop-color="#fff" stop-opacity=".1"/><stop offset=".75" stop-color="#fff" stop-opacity=".5"/>'
            '<stop offset="1" stop-color="#fff"/></radialGradient>'
            '<mask id="edgeMask" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">'
            '<rect width="1024" height="1024" fill="url(#edge)"/></mask>')
    body += f'<g mask="url(#edgeMask)" opacity=".3"><rect width="1024" height="1024" filter="url(#clouds)"{clip}/></g>'
    return defs, body

# Wordmark: "Harmonia" in Poppins Medium (Google Fonts, SIL Open Font License), outlined so no file needs the font.
# Cap height 106 on the 256 canvas, baseline at 180. To redo it: swift outline-wordmark.swift > wordmark-poppins.json
WORDMARK = json.load(open(os.path.join(HERE, "wordmark-poppins.json")))
def wordmark(x0, colour):
    """The outlined wordmark with its left edge at x0. Returns the path and its right edge."""
    dx = x0 - WORDMARK["left"]
    return (f'<path fill="{colour}" transform="translate({f(dx)} 0)" d="{WORDMARK["d"]}"/>',
            x0 + WORDMARK["right"] - WORDMARK["left"])

def svg(body, w, title, h=256, view=None):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view or f"0 0 {f(w)} {f(h)}"}" width="{f(w)}" height="{f(h)}" '
            f'role="img"><title>{title}</title>{body}</svg>\n')

def write(name, text):
    with open(os.path.join(HERE, name), "w") as fh: fh.write(text)
    print("wrote", name)

def artwork():
    """The lyre on the navy sky, edge to edge: the picture the mark was traced from."""
    s = 2.34
    sd, sb = sky(512, 724)
    ld, lb = shaded(512 - 128 * s, 512 - 128 * s, s)
    return svg(f"<defs>{sd}{ld}</defs>{sb}{lb}", 1024, "Harmonia", 1024)

def app_icon(small=False):
    # macOS grid on a 1024 canvas: an 824 rounded square inset 100, radius 185, the lyre at scale 2.6.
    # The 16 and 32 px cut fills more of the canvas (inset 40, radius 220) with the flat small cut at scale 3.5, and
    # leaves out the clouds and the halo, which don't show at that size.
    inset, radius, s = (40, 220, 3.5) if small else (100, 185, 2.6)
    side = 1024 - 2 * inset
    off = 512 - 128 * s
    tile = f'<clipPath id="tile"><rect x="{inset}" y="{inset}" width="{side}" height="{side}" rx="{radius}"/></clipPath>'
    sd, sb = sky(512, side / 2 * 1.414, ' clip-path="url(#tile)"', clouds=not small)
    if small:
        return svg(f"<defs>{tile}{sd}</defs>{sb}{mark(WHITE, small=True, tx=off, ty=off, s=s)}", 1024, "Harmonia app icon", 1024)
    ld, lb = shaded(off, off, s)
    return svg(f'<defs>{tile}{sd}{ld}</defs>{sb}<g clip-path="url(#tile)">{lb}</g>', 1024, "Harmonia app icon", 1024)

def favicon():
    """The small cut whose lyre follows the browser: graphite in light mode, white in dark mode."""
    body = mark(frame="FRAME", small=True).replace('fill="FRAME" stroke="FRAME"', 'class="fr"')
    style = (f"<style>.fr{{fill:{INK};stroke:{INK}}}"
             f"@media (prefers-color-scheme:dark){{.fr{{fill:{WHITE};stroke:{WHITE}}}}}</style>")
    return svg(style + body, 256, "Harmonia")

def data_uri(text):
    s = text.strip().replace('"', "'")
    for a, b in (("%", "%25"), ("<", "%3C"), (">", "%3E"), ("#", "%23"), ("{", "%7B"), ("}", "%7D"), ("@", "%40")):
        s = s.replace(a, b)
    return "data:image/svg+xml," + s

def update_index():
    """The page's favicon and the sidebar mark (the small cut, white on the graphite band) are inline in index.html."""
    html = open(INDEX).read()
    new = re.sub(r'(<link rel="icon" type="image/svg\+xml" href=")[^"]*(")', lambda m: m[1] + data_uri(favicon()) + m[2], html, 1)
    new = re.sub(r'(<svg class="ws-mark"[^>]*>).*?(</svg>)', lambda m: m[1] + mark(WHITE, small=True) + m[2], new, 1, re.S)
    if new != html:
        open(INDEX, "w").write(new)
        print("wrote public/index.html")

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
    write("artwork.svg", artwork())
    write("app-icon.svg", app_icon())
    write("app-icon-small.svg", app_icon(small=True))
    update_index()
