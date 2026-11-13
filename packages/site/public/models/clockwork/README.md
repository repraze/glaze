# Clockwork

A small desk toy (a pendulum, two gears, a bouncing ball and a lamp) made for the Glaze docs (the Animation
page) by [`scripts/make-clockwork.mjs`](../../../../../scripts/make-clockwork.mjs):
`node scripts/make-clockwork.mjs` rebuilds `clockwork.glb` byte for byte (no dependencies).

What it exercises in `loadGltf` and `AnimationMixer`:

- two animations over the same nodes, `Run` (2 s) and `Idle` (4 s), to crossfade between
- every interpolation: `LINEAR` rotations (the pendulum swings from a `Pivot` parent; gears turn in quarter-turn
  keys), a `CUBICSPLINE` translation (the ball's bounce, an exact parabola from its tangents), a `LINEAR` scale
  (the squash on landing) and a `STEP` scale (the lamp blinking)
- `KHR_materials_emissive_strength` on the lamp

Part of this repository, under its MIT licence.
