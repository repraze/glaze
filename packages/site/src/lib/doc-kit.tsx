import {
    CodeBlock,
    CodeBlockActions,
    CodeBlockContent,
    CodeBlockCopyButton,
    CodeBlockHeader,
    CodeBlockTitle,
} from "@repraze/kernelkit/components/code-block";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@repraze/kernelkit/components/table";
import {Tabs, TabsContent, TabsList, TabsTrigger} from "@repraze/kernelkit/components/tabs";
import {useHighlightedCode} from "@repraze/kernelkit/hooks/use-highlighted-code";
import {cn} from "@repraze/kernelkit/lib/utils";
import type * as React from "react";

export const CATEGORIES = ["Foundations", "Pipeline", "Scene", "Assets"] as const;

export type Category = (typeof CATEGORIES)[number];

export interface PropRow {
    name: string;
    type: string;
    default?: string;
    description?: string;
}

export interface DemoDef {
    title: string;
    description?: string;
    component: React.ComponentType;
    /** Preview frame: "center" (default), "start" (top-left), "full" (no padding), "tall". */
    layout?: "center" | "start" | "full" | "tall";
}

export interface DocDef {
    title: string;
    category: Category;
    description: string;
    /** Engine source file this page documents, relative to packages/glaze/src (links to GitHub). */
    engineFile?: string;
    demos: DemoDef[];
    props?: {component: string; rows: PropRow[]}[];
    /** Freeform content after the demos. */
    notes?: React.ComponentType;
    /** The notes' own h2 sections (`id` on each), listed in the table of contents after the demos. */
    sections?: {id: string; title: string}[];
    /** Sort order inside the category (lower first, default 50). */
    order?: number;
}

export interface DocEntry extends DocDef {
    slug: string;
    source: string;
    /** Source of each demo's own function, by demo index. */
    demoSources: string[];
}

export const defineDoc = (doc: DocDef) => doc;

/** The demo's own exported function, not the whole doc file. */
export function extractFunction(source: string, name: string): string {
    const start = source.search(new RegExp(`^export (function|const) ${name}\\b`, "m"));
    if (start < 0) {
        return "";
    }
    const rest = source.slice(start);
    const next = rest.slice(1).search(/^export /m);
    const body = next < 0 ? rest : rest.slice(0, next + 1);
    return body.replace(/^export /, "").trimEnd();
}

export function Code({
    code,
    language = "tsx",
    title,
    className,
}: {
    code: string;
    language?: string;
    title?: string;
    className?: string;
}) {
    const lines = useHighlightedCode(code, language);
    return (
        <CodeBlock className={className}>
            <CodeBlockHeader>
                <CodeBlockTitle>{title ?? language}</CodeBlockTitle>
                <CodeBlockActions>
                    <CodeBlockCopyButton value={code} />
                </CodeBlockActions>
            </CodeBlockHeader>
            <CodeBlockContent className="max-h-[480px] text-[13px]">
                {lines.map((line, i) => (
                    <span key={i} className="block min-h-lh">
                        {line}
                    </span>
                ))}
            </CodeBlockContent>
        </CodeBlock>
    );
}

const layoutClass: Record<NonNullable<DemoDef["layout"]>, string> = {
    center: "flex min-h-56 items-center justify-center p-8",
    start: "flex min-h-56 items-start justify-start p-8",
    full: "overflow-hidden",
    tall: "flex min-h-[28rem] items-center justify-center p-8",
};

export function Demo({demo, code}: {demo: DemoDef; code: string}) {
    const Component = demo.component;
    return (
        <section className="flex scroll-mt-24 flex-col gap-3" id={slugify(demo.title)}>
            <div className="flex flex-col gap-1">
                <h3 className="font-mono text-sm font-medium">{demo.title}</h3>
                {demo.description ? <p className="text-sm text-muted-foreground">{demo.description}</p> : null}
            </div>
            <Tabs defaultValue="preview">
                <TabsList>
                    <TabsTrigger value="preview">Preview</TabsTrigger>
                    <TabsTrigger value="code">Code</TabsTrigger>
                </TabsList>
                <TabsContent value="preview">
                    <div
                        data-slot="demo-frame"
                        className={cn("rounded-xl border bg-card", layoutClass[demo.layout ?? "center"])}
                    >
                        <Component />
                    </div>
                </TabsContent>
                <TabsContent value="code">
                    <Code code={code} />
                </TabsContent>
            </Tabs>
        </section>
    );
}

export function PropsTable({component, rows}: {component: string; rows: PropRow[]}) {
    return (
        <section className="flex flex-col gap-3">
            <h3 className="font-mono text-sm font-medium">{component}</h3>
            <div className="overflow-hidden rounded-xl border bg-card">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Prop</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>Default</TableHead>
                            <TableHead>Description</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.name}>
                                <TableCell className="font-mono text-xs text-primary-text">{row.name}</TableCell>
                                <TableCell className="font-mono text-xs whitespace-normal">{row.type}</TableCell>
                                <TableCell className="font-mono text-xs text-muted-foreground">
                                    {row.default ?? "-"}
                                </TableCell>
                                <TableCell className="text-sm whitespace-normal text-muted-foreground">
                                    {row.description}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </section>
    );
}

export function slugify(text: string) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}
