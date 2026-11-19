# Team Chat brand

**The mark ("Table"):** your message in the middle, with your six teammates sitting around it. A coral speech bubble
with a ring of six dots, one per teammate, each in that teammate's colour.

![Team Chat](lockup.svg)

## Files

| File | Use |
|---|---|
| `mark.svg` | The mark, full colour. 48 px and up. |
| `mark-small.svg` | Small cut: bigger dots and bubble so the gaps stay open. Below 48 px (favicon, sidebar header). |
| `mark-black.svg`, `mark-white.svg`, `mark-coral.svg` | One colour: print, stamps, single-colour surfaces. |
| `lockup.svg`, `lockup-white.svg` | Mark and wordmark side by side, for light and dark backgrounds. |
| `wordmark.svg`, `wordmark-white.svg` | Wordmark alone. |
| `app-icon.svg`, `app-icon-small.svg` | The macOS icon (1024 canvas), and its 16/32 px cut. |
| `board.html` | Final presentation board with mockups. `round-1/` holds the four first-round concepts. |
| `make-brand.py` | Writes every SVG above. Change the numbers there, then run `python3 make-brand.py`. |

The app icon itself is drawn by `macapp/make-icon.swift` from the same numbers. `macapp/build.sh` rebuilds the
`.icns` whenever that script changes. If you change the mark, change both.

## Colour

| Name | HEX | RGB | Where |
|---|---|---|---|
| Coral | `#E0583A` | 224 88 58 | The bubble. Brand colour. |
| Coral, text | `#C4462B` | 196 70 43 | Accent and active channel in light mode (4.9:1 with white). |
| Coral, dark | `#EB6B4D` | 235 107 77 | Accent in dark mode (5.4:1 on the dark background). |
| Warm ink | `#2A211E` | 42 33 30 | The band at the top of the chat list, icon tile, wordmark on light. |
| Ink, dark | `#1C1715` | 28 23 21 | That band in dark mode. |

The six dots, clockwise from the top: `#EAB308`, `#22C55E`, `#06B6D4`, `#3B82F6`, `#A855F7`, `#EF4444` (the
starter teammates' colours from `team.json`). Red sits at the upper left, away from the coral bubble's tail. The
logo keeps these fixed even if you change a teammate's colour in the app.

## Type

- **Wordmark:** custom monoline letters (stroke 22 on a 256-high canvas, round caps, bowls built on the same
  circles as the dots). It's drawn with strokes. They scale with the SVG, but expand them to outlines before
  sending the file to a cutter or embroiderer.
- **In the app:** the sidebar header sets "Team Chat" live in `ui-rounded` (SF Pro Rounded on a Mac), weight 800,
  next to `mark-small`. Body text stays the system font.

## Space and size

- **Clear space:** at least one dot's diameter (42 units on the 256 canvas) on every side of the mark or lockup.
- **Minimum size:** the mark at 16 px (use `mark-small.svg` below 48 px); the lockup at 120 px wide.
- **Backgrounds:** white, light greys, warm ink and near-black. On a coral or other saturated background, use the
  one-colour white version.

## Don't

- Don't recolour single dots, reorder them, or add a seventh.
- Don't rotate the mark or flip the bubble's tail to the right.
- Don't set the wordmark in another font, or squeeze it.
- Don't add gradients, shadows or outlines to the mark. (The app icon's tile has a soft gradient; the mark on it
  doesn't.)
- Don't put the full-colour mark on coral or on a busy photo.

## Notes

- The mark is original. It was drawn for Team Chat and checked against the big chat apps, but no trademark search
  has been done.
- 16 px test: the bubble and the ring of dots still read; the tail merges with the bubble. Fine for a favicon.
