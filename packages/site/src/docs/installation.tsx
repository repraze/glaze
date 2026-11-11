import {Alert, AlertDescription, AlertTitle} from "@repraze/kernelkit/components/alert";
import {Spinner} from "@repraze/kernelkit/components/spinner";
import {StatusDot} from "@repraze/kernelkit/components/status-dot";
import {Table, TableBody, TableCell, TableRow} from "@repraze/kernelkit/components/table";
import {MonitorOffIcon} from "lucide-react";
import {useEffect, useState} from "react";

import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Installation",
    category: "Foundations",
    description:
        "One ESM package, @repraze/glaze, with gl-matrix as its only dependency. It needs a browser with WebGPU; there is no WebGL fallback.",
    order: 1,
    demos: [
        {
            title: "WebGPU in this browser",
            description: "What Glaze sees here: the adapter, the canvas format it will configure, and a few limits.",
            component: FeatureCheck,
            layout: "start",
        },
    ],
    notes: Notes,
    sections: [
        {id: "install", title: "Install"},
        {id: "types", title: "Types"},
        {id: "imports", title: "Imports"},
        {id: "browser-support", title: "Browser support"},
    ],
    props: [
        {
            component: "Package exports",
            rows: [
                {name: "@repraze/glaze", type: "everything", description: "Every class, factory and type below."},
                {name: "/renderer", type: "Renderer", description: "Device, canvas context and the frame loop."},
                {name: "/render-graph", type: "RenderGraph", description: "Passes and the textures between them."},
                {name: "/pass", type: "Pass", description: "The base class every pass extends."},
                {
                    name: "/passes/*",
                    type: "ShaderPass · EffectPass · DeferredScenePass · BlitPass · SplitViewPass",
                    description: "The built-in passes, one subpath each.",
                },
                {
                    name: "/scene, /scene/*",
                    type: "Scene · Entity · Mesh · Camera · Light",
                    description: "The scene graph.",
                },
                {
                    name: "/geometry, /geometry/shapes",
                    type: "Geometry · create*",
                    description: "Meshes and shape factories.",
                },
                {name: "/material", type: "PBRMaterial", description: "The PBR material and its texture maps."},
                {name: "/texture, /uniform", type: "Texture · Uniform · TextureUniform", description: "GPU inputs."},
                {name: "/loaders/*", type: "glb · obj · stl", description: "Model parsers and URL loaders."},
                {name: "/color, /math/animation", type: "colorRgb · lerp · oscillate…", description: "Helpers."},
            ],
        },
    ],
});

function Notes() {
    return (
        <div className="flex flex-col gap-8">
            <section id="install" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Install</h2>
                <Code language="bash" code="npm install @repraze/glaze" />
                <p className="text-sm text-muted-foreground">
                    The package is ESM only and has no side effects, so bundlers keep only what you import.{" "}
                    <code className="font-mono text-foreground">gl-matrix</code> comes with it; import{" "}
                    <code className="font-mono text-foreground">vec3</code> and{" "}
                    <code className="font-mono text-foreground">mat4</code> from it to move entities.
                </p>
            </section>
            <section id="types" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Types</h2>
                <p className="text-sm text-muted-foreground">
                    The engine is written in TypeScript and ships declarations. The WebGPU globals (
                    <code className="font-mono text-foreground">GPUDevice</code>,{" "}
                    <code className="font-mono text-foreground">navigator.gpu</code>) come from{" "}
                    <code className="font-mono text-foreground">@webgpu/types</code>:
                </p>
                <Code language="bash" code="npm install -D @webgpu/types" />
                <Code
                    language="json"
                    title="tsconfig.json"
                    code={`{
    "compilerOptions": {
        "types": ["@webgpu/types"]
    }
}`}
                />
            </section>
            <section id="imports" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Imports</h2>
                <p className="text-sm text-muted-foreground">
                    Import from the root, or from a subpath when you want one module (the API table lists them):
                </p>
                <Code
                    code={`import {DeferredScenePass, Renderer, RenderGraph, Scene} from "@repraze/glaze";
import {ShaderPass} from "@repraze/glaze/passes/shader-pass";`}
                />
            </section>
            <section id="browser-support" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Browser support</h2>
                <p className="text-sm text-muted-foreground">
                    Glaze needs WebGPU in a secure context (https or localhost). Chrome and Edge ship it on desktop and
                    Android, Safari from version 26, Firefox on Windows and macOS. Elsewhere, enable it in the
                    browser&apos;s flags. Detect it before you start, and show something useful when it is missing:
                </p>
                <Code
                    code={`if (!navigator.gpu) {
    showFallback("This browser has no WebGPU.");
} else {
    try {
        const renderer = await Renderer.init(canvas);
    } catch (error) {
        // "No suitable GPU adapter found.": WebGPU exists, but no GPU was granted
        showFallback(String(error));
    }
}`}
                />
            </section>
        </div>
    );
}

type Check = {state: "checking"} | {state: "missing"; reason: string} | {state: "ready"; rows: [string, string][]};

export function FeatureCheck() {
    const [check, setCheck] = useState<Check>({state: "checking"});
    useEffect(() => {
        let cancelled = false;
        (async (): Promise<Check> => {
            if (!("gpu" in navigator) || !navigator.gpu) {
                return {state: "missing", reason: "navigator.gpu is undefined: this browser has no WebGPU."};
            }
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                return {state: "missing", reason: "requestAdapter() returned null: no GPU was granted to this page."};
            }
            const {vendor, architecture} = adapter.info;
            return {
                state: "ready",
                rows: [
                    ["adapter", [vendor, architecture].filter(Boolean).join(" · ") || "unknown"],
                    ["canvas format", navigator.gpu.getPreferredCanvasFormat()],
                    ["max texture 2D", `${adapter.limits.maxTextureDimension2D}px`],
                    ["max bind groups", String(adapter.limits.maxBindGroups)],
                    ["max color attachments", String(adapter.limits.maxColorAttachments)],
                    ["features", String(adapter.features.size)],
                ],
            };
        })()
            .catch((error: unknown): Check => ({state: "missing", reason: String(error)}))
            .then((result) => {
                if (!cancelled) {
                    setCheck(result);
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (check.state === "checking") {
        return <Spinner className="text-muted-foreground" />;
    }
    if (check.state === "missing") {
        return (
            <Alert color="warning" className="max-w-lg">
                <MonitorOffIcon />
                <AlertTitle>WebGPU is unavailable here</AlertTitle>
                <AlertDescription>{check.reason} Glaze scenes on this site show a fallback instead.</AlertDescription>
            </Alert>
        );
    }
    return (
        <div className="flex w-full max-w-lg flex-col gap-3">
            <StatusDot color="success">WebGPU ready</StatusDot>
            <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                    <TableBody>
                        {check.rows.map(([name, value]) => (
                            <TableRow key={name}>
                                <TableCell className="text-muted-foreground">{name}</TableCell>
                                <TableCell className="font-mono text-xs">{value}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}
