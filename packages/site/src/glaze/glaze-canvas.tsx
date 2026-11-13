import {
    type Camera,
    OrbitControls,
    type OrbitControlsOptions,
    PointerInput,
    Renderer,
    type RenderGraph,
} from "@repraze/glaze";
import {Button} from "@repraze/kernelkit/components/button";
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@repraze/kernelkit/components/empty";
import {Spinner} from "@repraze/kernelkit/components/spinner";
import {cn} from "@repraze/kernelkit/lib/utils";
import {Link} from "@tanstack/react-router";
import {MonitorOffIcon, TriangleAlertIcon} from "lucide-react";
import {useEffect, useRef, useState} from "react";

/** What a frame callback gets: seconds since the scene started (frozen under reduced motion), and the canvas size. */
export interface GlazeFrameInfo {
    time: number;
    delta: number;
    width: number;
    height: number;
}

/** Returns the graph to render this frame (build it once and return the same one, or rebuild it per frame). */
export type GlazeFrame = (frame: GlazeFrameInfo) => RenderGraph;

/** Where an orbit starts: like the `orbit` helper (degrees), plus a slow spin while idle. */
export interface OrbitView {
    distance: number;
    elevation?: number;
    azimuth?: number;
    target?: [number, number, number];
    /** Degrees per second while nobody touches it (frozen under reduced motion). */
    spin?: number;
}

export interface GlazeSetupContext {
    renderer: Renderer;
    canvas: HTMLCanvasElement;
    /**
     * Orbit controls on this canvas for `camera`, placed at `view`: updated every frame and removed on unmount.
     * Docs-friendly defaults: the page keeps wheel scrolling until the canvas is pressed, and one-finger vertical
     * swipes scroll the page on touch screens.
     */
    orbitControls(camera: Camera, view: OrbitView, options?: OrbitControlsOptions): OrbitControls;
}

/** Builds the scene once the device is ready, and returns the per-frame callback. */
export type GlazeSetup = (ctx: GlazeSetupContext) => GlazeFrame | Promise<GlazeFrame>;

type Status =
    | {kind: "idle"}
    | {kind: "running"}
    | {kind: "unsupported"}
    | {kind: "no-adapter"}
    | {kind: "error"; message: string};

const hasWebGpu = () => typeof navigator !== "undefined" && "gpu" in navigator && Boolean(navigator.gpu);

/**
 * A canvas that runs one Glaze scene. The device is requested the first time the canvas scrolls into view,
 * the loop pauses while it is off screen, and the drawing buffer follows the element's size. Without
 * WebGPU (or when the scene fails to start) it shows a fallback in place of the canvas, never a blank box.
 *
 * `setup` runs once per mount: read live values (React state) through a ref, see `useLatest`.
 */
export function GlazeCanvas({
    setup,
    label,
    className,
    maxPixelRatio = 2,
    alphaMode,
    pixelated = false,
}: {
    setup: GlazeSetup;
    /** What the scene shows, for screen readers. */
    label: string;
    className?: string;
    /** Cap on devicePixelRatio for the drawing buffer (lower is cheaper; 1 for pixel-art passes). */
    maxPixelRatio?: number;
    alphaMode?: GPUCanvasAlphaMode;
    pixelated?: boolean;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const setupRef = useRef(setup);
    const [status, setStatus] = useState<Status>(() => (hasWebGpu() ? {kind: "idle"} : {kind: "unsupported"}));

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !hasWebGpu()) {
            return;
        }
        let disposed = false;
        let started = false;
        let visible = false;
        let renderer: Renderer | null = null;
        let frame: GlazeFrame | null = null;
        let raf = 0;
        let last = 0;
        let time = 0;
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let input: PointerInput | null = null;
        const orbits: {controls: OrbitControls; spin: number}[] = [];
        const orbitControls = (camera: Camera, view: OrbitView, options: OrbitControlsOptions = {}) => {
            input ??= new PointerInput(canvas);
            const {distance, elevation = 20, azimuth = 0, target = [0, 0, 0], spin = 0} = view;
            const controls = new OrbitControls(camera, {
                target,
                minDistance: distance * 0.3,
                maxDistance: distance * 4,
                captureScroll: false,
                touchAction: "pan-y",
                ...options,
            });
            controls.setOrbit(distance, (azimuth * Math.PI) / 180, Math.PI / 2 - (elevation * Math.PI) / 180);
            controls.attach(input);
            orbits.push({controls, spin: (spin * Math.PI) / 180});
            return controls;
        };

        const resize = () => {
            if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
                return;
            }
            const dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
            const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
            const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
                renderer?.resize(w, h);
            }
        };

        const fail = (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            renderer?.destroy();
            renderer = null;
            frame = null;
            if (!disposed) {
                setStatus(/adapter/i.test(message) ? {kind: "no-adapter"} : {kind: "error", message});
            }
        };

        const loop = (now: number) => {
            raf = 0;
            if (disposed || !renderer || !frame || !visible) {
                return;
            }
            const delta = last ? Math.min((now - last) / 1000, 0.1) : 0;
            last = now;
            if (!reducedMotion.matches) {
                time += delta;
            }
            for (const {controls, spin} of orbits) {
                controls.autoRotate = reducedMotion.matches ? 0 : spin;
                controls.update(delta);
            }
            try {
                renderer.renderFrame(frame({time, delta, width: canvas.width, height: canvas.height}), time);
            } catch (error) {
                fail(error);
                return;
            }
            raf = requestAnimationFrame(loop);
        };

        const play = () => {
            if (!raf && renderer && frame && visible) {
                last = 0;
                raf = requestAnimationFrame(loop);
            }
        };

        const start = async () => {
            started = true;
            try {
                resize();
                const created = await Renderer.init(canvas, alphaMode ? {alphaMode} : undefined);
                if (disposed) {
                    created.destroy();
                    return;
                }
                renderer = created;
                const callback = await setupRef.current({renderer: created, canvas, orbitControls});
                if (disposed) {
                    return;
                }
                frame = callback;
                setStatus({kind: "running"});
                play();
            } catch (error) {
                if (!disposed) {
                    fail(error);
                }
            }
        };

        const intersection = new IntersectionObserver(([entry]) => {
            visible = Boolean(entry?.isIntersecting);
            if (!visible) {
                cancelAnimationFrame(raf);
                raf = 0;
            } else if (!started) {
                void start();
            } else {
                play();
            }
        });
        intersection.observe(canvas);
        const size = new ResizeObserver(resize);
        size.observe(canvas);

        return () => {
            disposed = true;
            intersection.disconnect();
            size.disconnect();
            cancelAnimationFrame(raf);
            input?.dispose();
            renderer?.destroy();
        };
    }, [maxPixelRatio, alphaMode]);

    const fallback = status.kind === "unsupported" || status.kind === "no-adapter" || status.kind === "error";
    return (
        <div
            data-slot="glaze-canvas"
            data-state={status.kind}
            className={cn("relative size-full overflow-hidden", className)}
        >
            <canvas
                ref={canvasRef}
                role="img"
                aria-label={label}
                className={cn(
                    "absolute inset-0 block size-full",
                    pixelated && "[image-rendering:pixelated]",
                    fallback && "invisible",
                )}
            />
            {status.kind === "idle" ? (
                <div className="absolute inset-0 flex items-center justify-center">
                    <Spinner className="text-muted-foreground" />
                </div>
            ) : null}
            {fallback ? <GlazeFallback status={status} /> : null}
        </div>
    );
}

/** In place of the canvas: why the scene can't run, in the kit's Empty. */
function GlazeFallback({status}: {status: Status}) {
    const failed = status.kind === "error";
    return (
        <Empty className="absolute inset-0 overflow-auto bg-card p-4">
            <EmptyHeader>
                <EmptyMedia variant="icon">{failed ? <TriangleAlertIcon /> : <MonitorOffIcon />}</EmptyMedia>
                <EmptyTitle>{failed ? "The scene failed to start" : "WebGPU is unavailable"}</EmptyTitle>
                <EmptyDescription>
                    {status.kind === "unsupported"
                        ? "This browser doesn't expose WebGPU, so this live scene can't render here. The code tab shows how it is built."
                        : status.kind === "no-adapter"
                          ? "WebGPU is present, but no GPU adapter was granted (a blocked GPU, a headless browser or a locked-down device). The code tab shows how it is built."
                          : null}
                    {status.kind === "error" ? <code className="font-mono text-xs">{status.message}</code> : null}
                </EmptyDescription>
            </EmptyHeader>
            {failed ? null : (
                <EmptyContent>
                    <Button
                        size="sm"
                        variant="outline"
                        nativeButton={false}
                        render={<Link to="/docs/$slug" params={{slug: "installation"}} hash="browser-support" />}
                    >
                        Browser support
                    </Button>
                </EmptyContent>
            )}
        </Empty>
    );
}

/** A ref that always holds the latest value: how a scene's frame callback reads React state. */
export function useLatest<T>(value: T) {
    const ref = useRef(value);
    ref.current = value;
    return ref;
}
