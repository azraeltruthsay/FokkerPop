# Dice face-texture themes

Drop a subdirectory here per theme. Each subdir becomes a selectable theme in
the dashboard's Dice / Dice Tray / Custom Dice Roll dropdowns.

## Format

```
assets/dice/
  my-theme/
    face-1.png
    face-2.png
    ...
    face-20.png        # up to 20; only as many as your widest die needs
    theme.json         # optional material overrides
```

Each `face-N.png` is the texture drawn on the face that represents the number
`N` on a die. Square PNGs (128×128 or larger) work best. `jpg`, `jpeg`, and
`webp` are also accepted.

If a die needs a face number that isn't provided (e.g. your theme only ships
`face-1.png` through `face-6.png` and someone rolls a D20), that face falls
back to the gold canvas renderer.

## theme.json (optional)

```json
{
  "color3d":    "0xffffff",
  "metalness":  0.3,
  "roughness":  0.4,
  "rollSound":  "dice.wav"
}
```

All fields optional. `color3d` is the mesh tint behind the face texture
(usually white so the texture shows through). `rollSound` names a file in
`assets/sounds/` that plays instead of the default `coin.wav` when dice of
this theme are rolled.

## Where to find textures

- [Kenney.nl](https://kenney.nl) — CC0 game assets
- [OpenGameArt.org](https://opengameart.org) — filter by CC0
- [Freesound.org](https://freesound.org) — for the `rollSound`, search "dice
  roll" and filter by CC0

Always check each asset's individual license, even on CC0-heavy sites.
