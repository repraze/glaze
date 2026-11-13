import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {vec3} from "gl-matrix";

import {createCube, createPlane, createSphere} from "../geometry/shapes";
import {PBRMaterial} from "../material/material";
import {ray} from "../math/ray";
import {PerspectiveCamera} from "./camera";
import {boxCollider, geometryCollider, sphereCollider} from "./collider";
import {Entity, layer} from "./entity";
import {Mesh} from "./mesh";
import {raycast} from "./raycast";
import {Scene} from "./scene";

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-4) =>
    a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]!) < eps);

const material = new PBRMaterial();
const cube = (z: number, size = 1) => {
    const m = new Mesh(createCube({size}), material);
    vec3.set(m.position, 0, 0, z);
    return m;
};
const down = () => ray.fromValues([0, 0, 10], [0, 0, -1]); // looking down -Z through the origin

describe("raycast", () => {
    test("returns every hit, nearest first, with world point and normal", () => {
        const scene = new Scene();
        const front = cube(2);
        const back = cube(-2);
        scene.add(back).add(front);
        const hits = raycast(scene, down());
        assert.deepEqual(
            hits.map((h) => h.entity),
            [front, back],
        );
        assert.ok(Math.abs(hits[0]!.distance - 7.5) < 1e-4);
        assert.ok(near(hits[0]!.point, [0, 0, 2.5]));
        assert.ok(near(hits[0]!.normal, [0, 0, 1]));
        assert.ok(hits[0]!.faceIndex >= 0 && hits[0]!.uv !== null);
    });

    test("layers and filter skip entities but not their children", () => {
        const scene = new Scene();
        const group = new Entity();
        group.layers = layer(5);
        group.collider = boxCollider([4, 4, 4]);
        const inside = cube(0);
        group.add(inside);
        scene.add(group);

        assert.deepEqual(
            raycast(scene, down(), {layers: layer(0)}).map((h) => h.entity),
            [inside],
        );
        assert.deepEqual(
            raycast(scene, down(), {filter: (e) => e !== group}).map((h) => h.entity),
            [inside],
        );
        assert.equal(raycast(scene, down())[0]!.entity, group); // the proxy box is nearer
    });

    test("collider = null opts a mesh out; disabled subtrees are skipped", () => {
        const scene = new Scene();
        const a = cube(1);
        a.collider = null;
        const parent = new Entity();
        parent.enabled = false;
        parent.add(cube(-1));
        scene.add(a).add(parent);
        assert.equal(raycast(scene, down()).length, 0);
    });

    test("an invisible proxy widens the target", () => {
        const scene = new Scene();
        const small = cube(0, 0.2);
        const proxy = new Entity();
        proxy.collider = sphereCollider(1);
        small.add(proxy);
        scene.add(small);
        const offCentre = ray.fromValues([0.6, 0, 10], [0, 0, -1]);
        const hits = raycast(scene, offCentre);
        assert.equal(hits.length, 1);
        assert.equal(hits[0]!.entity, proxy);
        assert.equal(hits[0]!.entity.parent, small);
    });

    test("follows transforms set since the last frame, including scale", () => {
        const scene = new Scene();
        const m = cube(0);
        scene.add(m);
        vec3.set(m.position, 3, 0, 0);
        vec3.set(m.scale, 2, 2, 2);
        assert.equal(raycast(scene, down()).length, 0);
        const hit = raycast(scene, ray.fromValues([3, 0, 10], [0, 0, -1]))[0]!;
        assert.ok(Math.abs(hit.distance - 9) < 1e-4); // the scaled cube's face is at z = 1
    });

    test("back faces are culled by default, hit when asked", () => {
        const scene = new Scene();
        const plane = new Mesh(createPlane({width: 2, height: 2}), material); // faces +Y
        scene.add(plane);
        const fromBelow = ray.fromValues([0, -5, 0], [0, 1, 0]);
        assert.equal(raycast(scene, fromBelow).length, 0);
        plane.collider = geometryCollider(undefined, {cullBackFace: false});
        const hit = raycast(scene, fromBelow)[0]!;
        assert.ok(near(hit.normal, [0, -1, 0]));
    });

    test("maxDistance drops far hits", () => {
        const scene = new Scene();
        scene.add(cube(0));
        assert.equal(raycast(scene, down(), {maxDistance: 5}).length, 0);
    });

    test("a mesh's collider follows a geometry swap", () => {
        const scene = new Scene();
        const m = cube(0, 0.2);
        scene.add(m);
        const wide = ray.fromValues([0.8, 0, 10], [0, 0, -1]);
        assert.equal(raycast(scene, wide).length, 0);
        m.geometry = createSphere({radius: 1});
        assert.equal(raycast(scene, wide).length, 1);
    });

    test("an entity subtree can be the target", () => {
        const scene = new Scene();
        const holder = new Entity();
        vec3.set(holder.position, 0, 0, -3);
        const m = cube(0);
        holder.add(m);
        scene.add(holder).add(cube(3));
        const hits = raycast(holder, down());
        assert.deepEqual(
            hits.map((h) => h.entity),
            [m],
        );
        assert.ok(near(hits[0]!.point, [0, 0, -2.5]));
    });
});

describe("Camera.getRay", () => {
    test("the centre ray hits what the camera looks at", () => {
        const scene = new Scene();
        const camera = new PerspectiveCamera({fov: Math.PI / 3});
        vec3.set(camera.position, 4, 3, 5);
        camera.lookAt([0, 0, 0]);
        scene.add(camera);
        const target = cube(0);
        scene.add(target);
        const r = camera.getRay(ray.create(), 0, 0, 16 / 9);
        assert.equal(raycast(scene, r)[0]?.entity, target);
        assert.ok(near(r.direction, vec3.normalize(vec3.create(), [-4, -3, -5])));
    });
});
