import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {vec3} from "gl-matrix";

import {Entity} from "./entity";
import {DirectionalLight, SpotLight} from "./light";

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) =>
    a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]!) < eps);

describe("Light orientation", () => {
    test("the direction option aims -Z", () => {
        const sun = new DirectionalLight({direction: [-0.5, -1, -0.6]});
        assert.ok(near(sun.getWorldDirection(), vec3.normalize(vec3.create(), [-0.5, -1, -0.6])));
    });

    test("defaults point straight down", () => {
        assert.ok(near(new DirectionalLight().getWorldDirection(), [0, -1, 0]));
        assert.ok(near(new SpotLight().getWorldDirection(), [0, -1, 0]));
    });

    test("a spot light turns with its parent", () => {
        const rig = new Entity();
        const spot = new SpotLight({direction: [0, 0, -1]});
        rig.add(spot);
        rig.rotateY(Math.PI / 2);
        assert.ok(near(spot.getWorldDirection(), [-1, 0, 0]));
    });

    test("lookAt aims a spot light at a point", () => {
        const spot = new SpotLight();
        vec3.set(spot.position, 0, 5, 0);
        spot.lookAt([5, 0, 0]);
        assert.ok(near(spot.getWorldDirection(), vec3.normalize(vec3.create(), [5, -5, 0])));
    });
});
