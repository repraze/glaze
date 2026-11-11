import {defineDoc as defineKitDoc, type DocDef} from "@repraze/kernelkit/docs";

import {GITHUB_URL} from "./site";

export {Code} from "@repraze/kernelkit/docs";

export const CATEGORIES = ["Foundations", "Pipeline", "Scene", "Assets"] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * A docs page of this site (one per file in src/docs, read statically by docsMetaPlugin). `engineFile` is the
 * engine source file the page documents, relative to packages/glaze/src: the page header links it on GitHub.
 */
export const defineDoc = ({engineFile, ...doc}: DocDef<Category> & {engineFile?: string}) =>
    defineKitDoc({
        ...doc,
        ...(engineFile
            ? {source: {label: engineFile, href: `${GITHUB_URL}/blob/main/packages/glaze/src/${engineFile}`}}
            : {}),
    });
