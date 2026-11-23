# Harmonia brand

**The mark ("Lyre"):** *harmonia* first meant fitting things together, then tuning a lyre's strings to each other.
The mark is a solid lyre whose horns curl out into a beak at the top and whose sound box comes to a point at the
bottom, with six strings, red to violet, fanning out a little as they fall into the box. The lyre is graphite on light
backgrounds and white on dark ones; the strings are the only colour. The app icon and the artwork set it on a navy sky
with a soft halo. The app used to be called Team Chat; its old brand is in `team-chat/`.

![Harmonia](lockup.svg)

## Files

| File | Use |
|---|---|
| `mark.svg` | The mark, full colour: graphite lyre, six coloured strings. On light backgrounds, 48 px and up. |
| `mark-reversed.svg` | The same with a white lyre, for dark backgrounds. |
| `mark-small.svg`, `mark-small-reversed.svg` | Small cut: a thicker lyre and wider strings, so the colour still reads. Below 48 px. |
| `favicon.svg` | The small cut with a lyre that follows the browser: graphite in light mode, white in dark mode. |
| `mark-black.svg`, `mark-white.svg`, `mark-ink.svg` | One colour: print, stamps, single-colour surfaces. |
| `lockup.svg`, `lockup-white.svg` | Mark and wordmark side by side, for light and dark backgrounds. |
| `lockup-stacked.svg` | Mark above the wordmark, for square spaces. |
| `wordmark.svg`, `wordmark-white.svg` | Wordmark alone. |
| `app-icon.svg`, `app-icon-small.svg` | The macOS icon (1024 canvas), and its 16/32 px cut. |
| `artwork.svg` | The lyre on the navy sky, edge to edge (1024 square): the picture the mark was traced from. For social images, slides and splash screens. |
| `board.html` | The round-2 presentation board, from when the lyre was a thin graphite frame. `round-2/` holds the three concepts it was picked from (Bar, Lyre, Chord). |
| `make-brand.py` | Writes every SVG above, and the favicon and sidebar mark in `public/index.html`. Change the numbers there, then run `python3 make-brand.py`. |
| `outline-wordmark.swift`, `wordmark-poppins.json` | The wordmark's outlines, taken from Poppins (see Type). |

The app icon itself is drawn by `macapp/make-icon.swift` from the same numbers (its clouds are its own noise, so their
shapes differ from the SVG's). `macapp/build.sh` rebuilds the `.icns` whenever that script changes. If you change the
mark, change `make-brand.py` and `make-icon.swift` together.

## Colour

| Name | HEX | RGB | Where |
|---|---|---|---|
| Graphite | `#202328` | 32 35 40 | The lyre on light, the wordmark, the band at the top of the chat list, buttons in light mode. |
| Graphite, dark | `#141518` | 20 21 24 | Panels in dark mode. |
| Mist | `#E8E9EC` | 232 233 236 | Buttons and accents in dark mode (with graphite text). |
| White | `#FFFFFF` | 255 255 255 | The lyre and wordmark on dark. |
| Navy | `#161D38` → `#2B3148` | 22 29 56 → 43 49 72 | The sky behind the app icon and the artwork: deepest in the middle, lighter toward the edges. |

The six strings, left to right: red `#F25165`, orange `#F28E2E`, yellow `#F5CA40`, green `#48DABF`, blue `#4298EF`,
violet `#8968F7`. In the app icon and the artwork each string is shaded (deeper at the top, brightest in the middle,
darker where it meets the box) and the lyre runs from warm white `#FBF8F1` at the horns to cool grey `#E4E2E8` at the
point; the flat marks use the colours above. There's no brand accent colour on purpose: the strings are the colour.
Where seven colours are too many (print, embroidery, a stamp), use a one-colour version.

## Type

- **Wordmark:** "Harmonia" in [Poppins](https://fonts.google.com/specimen/Poppins) Medium, outlined into paths
  (`outline-wordmark.swift` → `wordmark-poppins.json`), so no file needs the font. Poppins is under the SIL Open Font
  License, which allows logo use.
- **In the app:** the sidebar header shows the outlined wordmark next to `mark-small-reversed`. Body text stays the
  system font.

## Lines

On the 256 canvas the lyre spans x 41–215 and y 38.6–218; its outline is twelve cubic curves for the left half,
mirrored. The strings are 5.2 wide. The small cut thickens the lyre with a 6-unit stroke and widens the strings to 9.

## Space and size

- **Clear space:** at least 32 units on the 256 canvas (an eighth of the mark's height) on every side of the mark or
  lockup.
- **Minimum size:** the mark at 16 px (use the small cut below 48 px); the lockup at 120 px wide.
- **Backgrounds:** white and light greys take the graphite lyre; graphite, navy and near-black take the white one. On a
  saturated colour, use the one-colour white or black version.

## Don't

- Don't recolour, reorder, add or drop strings. Six strings, red to violet.
- Don't put a graphite lyre on a dark background, or a white one on a light background.
- Don't rotate or flip the mark, or straighten the horns.
- Don't set the wordmark live in another font, or squeeze it.
- Don't add shadows or outlines to the flat marks. The shading and the halo belong to the app icon and the artwork.

## Notes

- The mark is original, drawn for Harmonia and traced from the artwork picked on 2026-11-23. No trademark search has
  been done.
- 16 px test: the horns, the beaks and the point of the box still read, and the strings become one band of colour.
  Fine for a favicon; the small cut keeps that band from turning grey.
