import META from "virtual:docs-meta";

import {CATEGORIES, type Category, type DocDef, type DocEntry, extractFunction} from "@/lib/doc-kit";

/** Nav/search data for a docs page (from the build-time manifest, see plugins/docs-meta.ts). */
export interface DocMeta {
    slug: string;
    title: string;
    category: Category;
    description: string;
    order?: number;
}

type DocModule = {doc: DocDef} & Record<string, unknown>;

// Each page (demos + their source text) is its own chunk, loaded when the page is opened.
const modules = import.meta.glob<DocModule>("../docs/*.tsx");
const sources = import.meta.glob<string>("../docs/*.tsx", {query: "?raw", import: "default"});
const pathOf = (slug: string) => `../docs/${slug}.tsx`;

export const DOCS: DocMeta[] = (META as DocMeta[]).toSorted(
    (a, b) =>
        CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
        (a.order ?? 50) - (b.order ?? 50) ||
        a.title.localeCompare(b.title),
);

export const DOCS_BY_SLUG = new Map(DOCS.map((d) => [d.slug, d]));

export const DOCS_BY_CATEGORY = CATEGORIES.map((category) => ({
    category,
    docs: DOCS.filter((d) => d.category === category),
})).filter((group) => group.docs.length > 0);

/** Load a page's module and source; undefined for an unknown slug. */
export async function loadDoc(slug: string): Promise<DocEntry | undefined> {
    const load = modules[pathOf(slug)];
    const loadSource = sources[pathOf(slug)];
    if (!load || !loadSource) {
        return undefined;
    }
    const [mod, source] = await Promise.all([load(), loadSource()]);
    // Match demos to their export by identity: function names don't survive minification.
    const exportName = (component: unknown) => Object.keys(mod).find((key) => mod[key] === component) ?? "";
    return {
        ...mod.doc,
        slug,
        source,
        demoSources: mod.doc.demos.map((demo) => extractFunction(source, exportName(demo.component))),
    };
}
