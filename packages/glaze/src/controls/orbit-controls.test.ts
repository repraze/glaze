import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {vec3} from "gl-matrix";

import {OrthographicCamera, PerspectiveCamera} from "../scene/camera";
import {OrbitControls} from "./orbit-controls";

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

function camAt(x: number, y: number, z: number) {
    const camera = new PerspectiveCamera();
    vec3.set(camera.position, x, y, z);
    return camera;
}

describe("OrbitControls", () => {
    test("reads its orbit from where the camera already is, and looks at the target", () => {
        const camera = camAt(3, 4, 0);
        const controls = new OrbitControls(camera);
        assert.ok(near(controls.distance, 5));
        assert.ok(near(controls.azimuth, Math.PI / 2));
        assert.ok(near(controls.polar, Math.acos(4 / 5)));
        const dir = camera.getWorldDirection();
        assert.ok(near(dir[0], -0.6) && near(dir[1], -0.8));
    });

    test("without damping, a rotation lands at once", () => {
        const camera = camAt(0, 0, 5);
        const controls = new OrbitControls(camera, {damping: 0});
        controls.rotate(Math.PI / 2, 0).update();
        assert.ok(near(camera.position[0], 5) && near(camera.position[2], 0));
    });

    test("damping eases toward the full motion, independent of frame rate", () => {
        const run = (fps: number) => {
            const controls = new OrbitControls(camAt(0, 0, 5), {damping: 0.2});
            controls.rotate(1, 0);
            controls.update(1 / fps);
            const firstFrame = controls.azimuth;
            for (let i = 0; i < fps * 3; i++) {
                controls.update(1 / fps);
            }
            return {firstFrame, settled: controls.azimuth};
        };
        const at60 = run(60);
        const at144 = run(144);
        assert.ok(near(at60.firstFrame, 0.2));
        assert.ok(at144.firstFrame < at60.firstFrame);
        assert.ok(near(at60.settled, 1, 1e-3) && near(at144.settled, 1, 1e-3));
    });

    test("update reports motion, then settles", () => {
        const controls = new OrbitControls(camAt(0, 0, 5), {damping: 0.3});
        controls.rotate(0.5, 0);
        assert.equal(controls.update(), true);
        let frames = 0;
        while (controls.update() && frames < 1000) {
            frames++;
        }
        assert.ok(frames < 1000);
        assert.equal(controls.update(), false);
    });

    test("polar and distance limits clamp", () => {
        const controls = new OrbitControls(camAt(0, 0, 5), {
            damping: 0,
            minPolarAngle: 0.5,
            maxPolarAngle: 2,
            minDistance: 2,
            maxDistance: 8,
        });
        controls.rotate(0, -10).update();
        assert.ok(near(controls.polar, 0.5));
        controls.zoom(100).update();
        assert.ok(near(controls.distance, 8));
        controls.zoom(0.001).update();
        assert.ok(near(controls.distance, 2));
    });

    test("pan moves the target and the camera together", () => {
        const camera = camAt(0, 0, 5);
        const controls = new OrbitControls(camera, {damping: 0});
        controls.pan(1, 2).update();
        assert.ok(near(controls.target[0], 1) && near(controls.target[1], 2));
        assert.ok(near(camera.position[0], 1) && near(camera.position[1], 2) && near(camera.position[2], 5));
    });

    test("an orthographic camera zooms by scaling its view box", () => {
        const camera = new OrthographicCamera({left: -2, right: 2, top: 1, bottom: -1});
        vec3.set(camera.position, 0, 0, 5);
        const controls = new OrbitControls(camera, {damping: 0});
        controls.zoom(0.5).update();
        assert.ok(near(camera.right, 1) && near(camera.top, 0.5));
        assert.ok(near(controls.distance, 5));
    });
});

describe("OrbitControls near the poles", () => {
    test("sweeping over the top stays continuous: no roll, always facing the target", () => {
        const camera = camAt(0, 0, 5);
        const controls = new OrbitControls(camera, {damping: 0, minPolarAngle: 1e-4});
        controls.setOrbit(5, 0.7, 0.6);
        let previousRight: vec3 | null = null;
        for (let i = 0; i < 200; i++) {
            controls.rotate(0, -0.005).update();
            const m = camera.computeWorldMatrix();
            const right = vec3.fromValues(m[0]!, m[1]!, m[2]!);
            assert.ok(Math.abs(right[1]) < 1e-5, "the camera's right axis stays level (no roll)");
            if (previousRight !== null) {
                assert.ok(vec3.dot(right, previousRight) > 0.999, `no jump at polar ${controls.polar}`);
            }
            previousRight = right;
            const toTarget = vec3.normalize(vec3.create(), vec3.negate(vec3.create(), camera.position));
            assert.ok(vec3.dot(camera.getWorldDirection(), toTarget) > 0.99999);
        }
        assert.ok(near(controls.polar, 1e-4));
    });
});

describe("OrbitControls auto-rotate", () => {
    test("spins while idle, pauses after a gesture", () => {
        const controls = new OrbitControls(camAt(0, 0, 5), {damping: 0, autoRotate: 1, autoRotateDelay: 0.5});
        controls.update(0.25);
        assert.ok(near(controls.azimuth, 0.25));
        controls.rotate(0.1, 0); // from code: not a user gesture, keeps spinning
        controls.wheel({ctrlKey: true, deltaY: 0} as never); // a gesture: pause
        const before = controls.azimuth;
        controls.update(0.25);
        assert.ok(near(controls.azimuth, before + 0.1));
        controls.update(0.3);
        assert.ok(controls.azimuth > before + 0.1 + 0.2);
    });
});

describe("OrbitControls captureScroll", () => {
    const wheel = {
        deltaX: 0,
        deltaY: 30,
        legacyDeltaY: 0,
        discrete: false,
        ctrlKey: false,
        shiftKey: false,
        height: 100,
    };
    const press = {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        x: 0,
        y: 0,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
    };
    test("off: the page keeps scrolling until the canvas is pressed, and again after the pointer leaves", () => {
        const controls = new OrbitControls(camAt(0, 0, 5), {captureScroll: false});
        assert.equal(controls.wheel(wheel as never), false);
        assert.equal(controls.wheel({...wheel, ctrlKey: true} as never), true, "pinch always zooms");
        controls.pointerDown(press as never);
        controls.pointerUp(press as never);
        assert.equal(controls.wheel(wheel as never), true);
        controls.hover(press as never, false);
        assert.equal(controls.wheel(wheel as never), false);
    });
});
