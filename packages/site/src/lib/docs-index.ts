import {createDocsIndex} from "@repraze/kernelkit/docs";
import META from "virtual:docs-meta";

import {CATEGORIES} from "@/lib/doc-kit";

/** Nav, search, pager and loader data for the docs (the build-time manifest plus one chunk per page). */
export const DOCS_INDEX = createDocsIndex({
    categories: CATEGORIES,
    meta: META,
    modules: import.meta.glob("../docs/*.tsx"),
    sources: import.meta.glob("../docs/*.tsx", {query: "?demo-sources", import: "default"}),
});
