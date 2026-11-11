import {Badge} from "@repraze/kernelkit/components/badge";
import {Button} from "@repraze/kernelkit/components/button";
import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    LinkCard,
    LinkCardArrow,
} from "@repraze/kernelkit/components/card";
import {
    Hero,
    HeroActions,
    HeroBody,
    HeroDescription,
    HeroEyebrow,
    HeroFooter,
    HeroShowcase,
    HeroTitle,
} from "@repraze/kernelkit/components/hero";
import {
    Section,
    SectionAction,
    SectionDescription,
    SectionEyebrow,
    SectionHeader,
    SectionTitle,
} from "@repraze/kernelkit/components/section";
import {SiteContainer} from "@repraze/kernelkit/components/site-layout";
import {Link} from "@tanstack/react-router";
import {ArrowRightIcon, CpuIcon, PackageIcon, PaletteIcon, TerminalIcon, TriangleIcon} from "lucide-react";

import {GithubIcon} from "@/components/github-icon";
import {GlazeShowcase} from "@/components/hero-showcase";
import {PipelineDiagram} from "@/components/pipeline-diagram";
import {Code} from "@/lib/doc-kit";
import {DOCS, DOCS_BY_SLUG} from "@/lib/docs-index";
import {GITHUB_URL, usePageTitle} from "@/lib/site";

const PIPELINE = ["renderer", "render-graph", "shader-pass", "deferred-scene-pass", "g-buffer", "uniforms"];
const SCENE = ["lights", "materials", "geometry", "camera", "textures", "loaders"];

const USAGE = `import {BlitPass, DeferredScenePass, Renderer, RenderGraph} from "@repraze/glaze";

const renderer = await Renderer.init(canvas);
const graph = new RenderGraph();
const {color} = graph.addPass(new DeferredScenePass({scene}));
graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});
renderer.startAnimation(graph);`;

export function HomePage() {
    usePageTitle();
    const demoCount = DOCS.filter((d) => d.category !== "Foundations").length;
    return (
        <main className="flex flex-1 flex-col">
            <Hero layout="split">
                <HeroBody>
                    <HeroEyebrow>
                        <Badge variant="outline">
                            <span className="size-1.5 rounded-full bg-success" /> v0.1 alpha · WebGPU only
                        </Badge>
                    </HeroEyebrow>
                    <HeroTitle>
                        A WebGPU engine with a <span className="text-primary-text">glaze</span> of light.
                    </HeroTitle>
                    <HeroDescription>
                        Composable render passes, a deferred PBR scene pass with shadows, lights, materials and loaders.
                        Typed classes and WGSL, wired by a render graph, frame after frame.
                    </HeroDescription>
                    <HeroActions>
                        <Button
                            size="lg"
                            nativeButton={false}
                            render={<Link to="/docs/$slug" params={{slug: "getting-started"}} />}
                        >
                            Get started <ArrowRightIcon data-icon="inline-end" />
                        </Button>
                        <Button
                            size="lg"
                            variant="outline"
                            nativeButton={false}
                            render={<Link to="/docs/$slug" params={{slug: "pass-chain"}} />}
                        >
                            Explore the pipeline
                        </Button>
                    </HeroActions>
                    <HeroFooter>
                        <Code language="bash" code="npm install @repraze/glaze" className="w-full max-w-sm text-left" />
                    </HeroFooter>
                </HeroBody>
                <HeroShowcase>
                    <GlazeShowcase />
                </HeroShowcase>
            </Hero>

            <SiteContainer className="flex flex-col divide-y divide-border">
                <Section>
                    <SectionHeader>
                        <SectionEyebrow>Pipeline</SectionEyebrow>
                        <SectionTitle>Passes in, pixels out</SectionTitle>
                        <SectionDescription>
                            A frame is a render graph: passes declare the textures they read and write, the renderer
                            allocates and wires them, and any output can feed the next pass.
                        </SectionDescription>
                        <SectionAction>
                            <Button
                                variant="outline"
                                nativeButton={false}
                                render={<Link to="/docs/$slug" params={{slug: "pass-chain"}} />}
                            >
                                The pass chain <ArrowRightIcon data-icon="inline-end" />
                            </Button>
                        </SectionAction>
                    </SectionHeader>
                    <div className="flex flex-col gap-4">
                        <PipelineDiagram />
                        <DocCards slugs={PIPELINE} />
                    </div>
                </Section>

                <Section>
                    <SectionHeader>
                        <SectionEyebrow>Scene</SectionEyebrow>
                        <SectionTitle>Lights, materials, geometry</SectionTitle>
                        <SectionDescription>
                            Everything the deferred pass draws: a scene graph of meshes, cameras and lights, PBR
                            materials with texture maps, shape factories and model loaders. {demoCount} pages, each with
                            live scenes.
                        </SectionDescription>
                        <SectionAction>
                            <Button
                                variant="outline"
                                nativeButton={false}
                                render={<Link to="/docs/$slug" params={{slug: "scene-graph"}} />}
                            >
                                The scene graph <ArrowRightIcon data-icon="inline-end" />
                            </Button>
                        </SectionAction>
                    </SectionHeader>
                    <DocCards slugs={SCENE} />
                </Section>

                <Section>
                    <SectionHeader>
                        <SectionEyebrow>Install</SectionEyebrow>
                        <SectionTitle>One package, one dependency</SectionTitle>
                        <SectionDescription>
                            ESM, typed, side-effect free; gl-matrix for the math. It needs WebGPU: every scene on this
                            site shows a fallback where WebGPU is missing.
                        </SectionDescription>
                        <SectionAction>
                            <Button
                                variant="outline"
                                nativeButton={false}
                                render={<Link to="/docs/$slug" params={{slug: "installation"}} />}
                            >
                                Installation <ArrowRightIcon data-icon="inline-end" />
                            </Button>
                        </SectionAction>
                    </SectionHeader>
                    <div className="grid gap-4 md:grid-cols-[2fr_3fr]">
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <PackageIcon className="size-4 text-primary-text" /> Package
                                </CardTitle>
                                <CardDescription>The engine, its types and its loaders.</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <Code
                                    language="bash"
                                    code={`npm install @repraze/glaze\nnpm install -D @webgpu/types`}
                                />
                            </CardContent>
                        </Card>
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <TriangleIcon className="size-4 text-primary-text" /> First frame
                                </CardTitle>
                                <CardDescription>A scene pass, tone mapped onto the canvas.</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <Code code={USAGE} />
                            </CardContent>
                        </Card>
                    </div>
                </Section>

                <Section>
                    <SectionHeader>
                        <SectionEyebrow>The suite</SectionEyebrow>
                        <SectionTitle>One design language</SectionTitle>
                        <SectionDescription>
                            GlazeEngine, KernelKit, TermiColor and repraze.com share the header, sidebar, spacing and
                            states. Each keeps its own accent and radius.
                        </SectionDescription>
                        <SectionAction>
                            <Button variant="outline" nativeButton={false} render={<a href={GITHUB_URL} />}>
                                <GithubIcon data-icon="inline-start" className="size-4" /> Source on GitHub
                            </Button>
                        </SectionAction>
                    </SectionHeader>
                    <div className="grid gap-4 md:grid-cols-3">
                        {SUITE.map((site) => (
                            <LinkCard key={site.name} href={site.href} className="h-full">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <site.icon className="size-4 text-primary-text" /> {site.name}
                                    </CardTitle>
                                    <CardDescription>{site.description}</CardDescription>
                                    <CardAction>
                                        <LinkCardArrow external />
                                    </CardAction>
                                </CardHeader>
                            </LinkCard>
                        ))}
                    </div>
                </Section>
            </SiteContainer>
        </main>
    );
}

/** Docs pages as destinations: title and description from the docs manifest. */
function DocCards({slugs}: {slugs: string[]}) {
    return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {slugs.flatMap((slug) => {
                const doc = DOCS_BY_SLUG.get(slug);
                return doc
                    ? [
                          <LinkCard key={slug} render={<Link to="/docs/$slug" params={{slug}} />} className="h-full">
                              <CardHeader>
                                  <CardTitle>{doc.title}</CardTitle>
                                  <CardDescription className="line-clamp-2">{doc.description}</CardDescription>
                                  <CardAction>
                                      <LinkCardArrow />
                                  </CardAction>
                              </CardHeader>
                          </LinkCard>,
                      ]
                    : [];
            })}
        </div>
    );
}

const SUITE = [
    {
        name: "KernelKit",
        icon: TerminalIcon,
        href: "https://repraze.github.io/kernelkit/",
        description: "The components: shadcn on Base UI, and the site shell this site is built from.",
    },
    {
        name: "TermiColor",
        icon: PaletteIcon,
        href: "https://repraze.github.io/termicolor/",
        description: "The palette: themes for your editor, terminal and prompt, and the colors of these scenes.",
    },
    {
        name: "repraze.com",
        icon: CpuIcon,
        href: "https://repraze.com",
        description: "Posts on projects, reviews and tutorials, and the lab these demos started in.",
    },
] as const;
