import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {vec3} from "gl-matrix";

import {OrbitControls} from "../controls/orbit-controls";
import {createCube} from "../geometry/shapes";
import {PBRMaterial} from "../material/material";
import {PerspectiveCamera} from "../scene/camera";
import {sphereCollider} from "../scene/collider";
import {Entity, layer} from "../scene/entity";
import {Mesh} from "../scene/mesh";
import {Scene} from "../scene/scene";
import {type PointerConsumer, PointerInput, type ScenePointerEvent} from "./pointer-input";

/** A stand-in canvas: 200 x 100 CSS px at the page origin, dispatching what `fire` sends. */
function fakeCanvas() {
    const listeners = new Map<string, ((e: unknown) => void)[]>();
    const captured = new Set<number>();
    const el = {
        style: {touchAction: ""},
        addEventListener: (type: string, fn: (e: unknown) => void) => {
            listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        },
        removeEventListener: (type: string, fn: (e: unknown) => void) => {
            listeners.set(
                type,
                (listeners.get(type) ?? []).filter((f) => f !== fn),
            );
        },
        getBoundingClientRect: () => ({left: 0, top: 0, width: 200, height: 100}),
        setPointerCapture: (id: number) => captured.add(id),
        releasePointerCapture: (id: number) => captured.delete(id),
        hasPointerCapture: (id: number) => captured.has(id),
    };
    const fire = (type: string, init: Record<string, unknown> = {}) => {
        let prevented = false;
        const e = {
            pointerId: 1,
            pointerType: "mouse",
            button: 0,
            buttons: 0,
            clientX: 100,
            clientY: 50,
            shiftKey: false,
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            deltaY: 0,
            deltaMode: 0,
            preventDefault: () => {
                prevented = true;
            },
            ...init,
        };
        for (const fn of listeners.get(type) ?? []) {
            fn(e);
        }
        return prevented;
    };
    return {element: el as unknown as HTMLCanvasElement, fire, listeners};
}

/** A scene with a camera at z = 10 looking at the origin, and a unit cube there. */
function setup() {
    const scene = new Scene();
    const camera = new PerspectiveCamera({fov: Math.PI / 3});
    vec3.set(camera.position, 0, 0, 10);
    scene.add(camera);
    scene.activeCamera = camera;
    const cube = new Mesh(createCube({size: 1}), new PBRMaterial());
    scene.add(cube);
    const canvas = fakeCanvas();
    const input = new PointerInput(canvas.element, {scene});
    return {scene, camera, cube, canvas, input};
}

const CENTRE = {clientX: 100, clientY: 50};
const EDGE = {clientX: 5, clientY: 5};

describe("PointerInput: scene events", () => {
    test("click on a mesh bubbles to its ancestors", () => {
        const {scene, cube, canvas, input} = setup();
        const group = new Entity();
        scene.remove(cube);
        group.add(cube);
        scene.add(group);
        const log: string[] = [];
        input.on(cube, "click", (e) => log.push(`cube ${e.target === cube} ${e.hit !== null}`));
        input.on(group, "click", (e) => log.push(`group ${e.currentTarget === group}`));
        canvas.fire("pointerdown", CENTRE);
        canvas.fire("pointerup", CENTRE);
        assert.deepEqual(log, ["cube true true", "group true"]);
    });

    test("no click after a drag, nor on empty space", () => {
        const {cube, canvas, input} = setup();
        let clicks = 0;
        input.on(cube, "click", () => clicks++);
        canvas.fire("pointerdown", CENTRE);
        canvas.fire("pointerup", {clientX: 120, clientY: 50});
        canvas.fire("pointerdown", EDGE);
        canvas.fire("pointerup", EDGE);
        assert.equal(clicks, 0);
    });

    test("events pass through to hits behind unless stopped", () => {
        const {scene, cube, canvas, input} = setup();
        const back = new Mesh(createCube({size: 1}), new PBRMaterial());
        vec3.set(back.position, 0, 0, -3);
        scene.add(back);
        const log: string[] = [];
        input.on(cube, "pointerdown", () => log.push("front"));
        input.on(back, "pointerdown", () => log.push("back"));
        canvas.fire("pointerdown", CENTRE);
        canvas.fire("pointerup", CENTRE);
        assert.deepEqual(log, ["front", "back"]);

        log.length = 0;
        input.on(cube, "pointerdown", (e) => e.stopPropagation());
        canvas.fire("pointerdown", CENTRE);
        assert.deepEqual(log, ["front"]);
    });

    test("an ancestor shared by two hits runs once, for the nearest", () => {
        const {scene, cube, canvas, input} = setup();
        const group = new Entity();
        const back = new Mesh(createCube({size: 1}), new PBRMaterial());
        vec3.set(back.position, 0, 0, -3);
        scene.remove(cube);
        group.add(cube).add(back);
        scene.add(group);
        const targets: Entity[] = [];
        input.on(group, "click", (e) => targets.push(e.target));
        canvas.fire("pointerdown", CENTRE);
        canvas.fire("pointerup", CENTRE);
        assert.deepEqual(targets, [cube]);
    });

    test("layers limit what the input can hit", () => {
        const {cube, canvas, input} = setup();
        cube.layers = layer(3);
        let clicks = 0;
        input.on(cube, "click", () => clicks++);
        input.layers = layer(0);
        canvas.fire("pointerdown", CENTRE);
        canvas.fire("pointerup", CENTRE);
        assert.equal(clicks, 0);
        input.layers = layer(0) | layer(3);
        canvas.fire("pointerdown", CENTRE);
        canvas.fire("pointerup", CENTRE);
        assert.equal(clicks, 1);
    });

    test("an invisible proxy collider routes events to its owner", () => {
        const {scene, canvas, input} = setup();
        const small = new Mesh(createCube({size: 0.05}), new PBRMaterial());
        vec3.set(small.position, 3, 0, 0);
        const hitbox = new Entity();
        hitbox.collider = sphereCollider(1.5);
        small.add(hitbox);
        scene.add(small);
        let clicked: Entity | null = null;
        input.on(small, "click", (e) => (clicked = e.currentTarget));
        // 3 world units right of centre at distance 10, fov 60°: about 26 px right of the centre line.
        const at = {clientX: 126, clientY: 50};
        canvas.fire("pointerdown", at);
        canvas.fire("pointerup", at);
        assert.equal(clicked, small);
    });

    test("hover: enter and leave follow the nearest hit and its ancestors", () => {
        const {scene, cube, canvas, input} = setup();
        const group = new Entity();
        scene.remove(cube);
        group.add(cube);
        scene.add(group);
        const log: string[] = [];
        for (const [name, e] of [
            ["cube", cube],
            ["group", group],
        ] as const) {
            input.on(e, "pointerenter", () => log.push(`enter ${name}`));
            input.on(e, "pointerleave", () => log.push(`leave ${name}`));
        }
        canvas.fire("pointermove", CENTRE);
        canvas.fire("pointermove", {clientX: 101, clientY: 50});
        canvas.fire("pointermove", EDGE);
        canvas.fire("pointermove", CENTRE);
        canvas.fire("pointerleave", CENTRE);
        assert.deepEqual(log, [
            "enter group",
            "enter cube",
            "leave cube",
            "leave group",
            "enter group",
            "enter cube",
            "leave cube",
            "leave group",
        ]);
    });
});

describe("PointerInput: gestures", () => {
    test("capture owns the drag: moves reach the entity off it, controls never see the gesture", () => {
        const {camera, cube, canvas, input} = setup();
        const controls = new OrbitControls(camera, {damping: 0}).attach(input);
        const before = vec3.clone(camera.position);
        const moves: ScenePointerEvent[] = [];
        let up = 0;
        input.on(cube, "pointerdown", (e) => e.capture());
        input.on(cube, "pointermove", (e) => moves.push(e));
        input.on(cube, "pointerup", () => up++);
        canvas.fire("pointerdown", CENTRE);
        canvas.fire("pointermove", {...EDGE, buttons: 1});
        canvas.fire("pointerup", EDGE);
        controls.update(1 / 60);
        assert.equal(moves.length, 1);
        assert.equal(moves[0]!.target, cube);
        assert.equal(moves[0]!.hit, null);
        assert.equal(up, 1);
        assert.ok(vec3.equals(camera.position, before));
    });

    test("an uncaptured drag orbits the camera; a tap still clicks", () => {
        const {camera, cube, canvas, input} = setup();
        const controls = new OrbitControls(camera, {damping: 0}).attach(input);
        let clicks = 0;
        input.on(cube, "click", () => clicks++);
        canvas.fire("pointerdown", CENTRE);
        canvas.fire("pointerup", CENTRE);
        assert.equal(clicks, 1);

        canvas.fire("pointerdown", CENTRE);
        // 10 px of a 100 px tall canvas: a tenth of a turn.
        canvas.fire("pointermove", {clientX: 110, clientY: 50, buttons: 1});
        canvas.fire("pointerup", {clientX: 110, clientY: 50});
        controls.update(1 / 60);
        assert.equal(clicks, 1);
        assert.ok(Math.abs(camera.position[0] - 10 * Math.sin(-Math.PI / 5)) < 1e-4, "dragging right swings it left");
        assert.ok(Math.abs(vec3.length(camera.position) - 10) < 1e-4, "distance kept");
    });

    test("consumers are offered pointerdown by priority; decliners still get pointerup", () => {
        const {canvas, input} = setup();
        const log: string[] = [];
        const high: PointerConsumer = {
            pointerDown: () => (log.push("high down"), false),
            pointerMove: () => log.push("high move"),
            pointerUp: () => log.push("high up"),
        };
        const low: PointerConsumer = {
            pointerDown: () => (log.push("low down"), true),
            pointerMove: () => log.push("low move"),
            pointerUp: () => log.push("low up"),
        };
        input.addConsumer(low, -5);
        input.addConsumer(high, 500);
        canvas.fire("pointerdown", EDGE);
        canvas.fire("pointermove", CENTRE);
        canvas.fire("pointerup", CENTRE);
        assert.deepEqual(log, ["high down", "low down", "low move", "high up", "low up"]);
    });

    test("wheel zooms through the controls and prevents page scroll", () => {
        const {camera, canvas, input} = setup();
        const controls = new OrbitControls(camera, {damping: 0}).attach(input);
        assert.equal(canvas.fire("wheel", {deltaY: -500}), true);
        controls.update();
        assert.ok(vec3.length(camera.position) < 10);
    });

    test("dispose removes every listener", () => {
        const {canvas, input} = setup();
        input.dispose();
        for (const fns of canvas.listeners.values()) {
            assert.equal(fns.length, 0);
        }
    });
});
