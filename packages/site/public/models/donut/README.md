# Donut

A glazed donut with sprinkles on a lace doily, made for the Glaze docs (the Introduction page) by
[`scripts/make-donut.mjs`](../../../../../scripts/make-donut.mjs): `node scripts/make-donut.mjs` rebuilds
`donut.glb` byte for byte (seeded, no dependencies).

What it exercises in `loadGltf`:

- a named node hierarchy: `Donut` > `Dough`, `Icing`, `Sprinkles` > `Sprinkle 001`…`Sprinkle 200`, and `Doily`
- 200 sprinkle nodes over five meshes (one per color) that all read the same accessors: one shared geometry
- embedded PNG textures: the baked dough color (the pale fryer ring) and the lace, whose alpha cuts the holes
- `alphaMode: "MASK"` with `doubleSided: true` on the lace
- normalized `uint16` texture coordinates on the sprinkles and the doily

Part of this repository, under its MIT licence.
