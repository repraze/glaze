# Clockwork

A small desk toy (a pendulum, two gears, a bouncing ball, a waving stalk and a lamp) made for the Glaze docs (the Animation
page) by [`scripts/make-clockwork.mjs`](../../../../../scripts/make-clockwork.mjs):
`node scripts/make-clockwork.mjs` rebuilds `clockwork.glb` byte for byte (no dependencies).

What it exercises in `loadGltf` and `AnimationMixer`:

- two animations over the same nodes, `Run` (2 s) and `Idle` (4 s), to crossfade between
- every interpolation: `LINEAR` rotations (the pendulum swings from a `Pivot` parent; gears turn in quarter-turn
  keys), a `CUBICSPLINE` translation (the ball's bounce, an exact parabola from its tangents), a `LINEAR` scale
  (the squash on landing) and a `STEP` scale (the lamp blinking)
- a skin: the `Stalk` tube is weighted to a chain of four bones (`Bone 1`…`Bone 4`, each ring blended between
  the two around it), with inverse bind matrices; the `Bulb` is a rigid mesh parented to the last bone
- `JOINTS_0` as unsigned bytes, `WEIGHTS_0` as floats
- `KHR_materials_emissive_strength` on the lamp

Part of this repository, under its MIT licence.
