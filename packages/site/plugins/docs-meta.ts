import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

import ts from "typescript";
import type {Plugin} from "vite";

/** What the nav, search and home page need about a docs page, without loading its demos. */
export interface DocMeta {
    slug: string;
    title: string;
    category: string;
    description: string;
    order?: number;
}

const ID = "virtual:docs-meta";
const RESOLVED = `\0${ID}`;

/** Static value of a string/number expression: literals, no-substitution templates, "a" + "b". */
function literal(node: ts.Expression): string | number | undefined {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
    }
    if (ts.isNumericLiteral(node)) {
        return Number(node.text);
    }
    if (ts.isParenthesizedExpression(node)) {
        return literal(node.expression);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const a = literal(node.left);
        const b = literal(node.right);
        return a !== undefined && b !== undefined ? `${a}${b}` : undefined;
    }
    return undefined;
}

function extract(file: string, slug: string): DocMeta {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    let meta: DocMeta | undefined;
    const visit = (node: ts.Node) => {
        if (
            !meta &&
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "defineDoc" &&
            node.arguments[0] &&
            ts.isObjectLiteralExpression(node.arguments[0])
        ) {
            const props: Record<string, string | number | undefined> = {};
            for (const p of node.arguments[0].properties) {
                if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
                    props[p.name.text] = literal(p.initializer);
                }
            }
            if (typeof props.title !== "string" || typeof props.category !== "string") {
                throw new Error(`${file}: defineDoc needs literal "title" and "category" (read at build time)`);
            }
            meta = {
                slug,
                title: props.title,
                category: props.category,
                description: typeof props.description === "string" ? props.description : "",
                ...(typeof props.order === "number" ? {order: props.order} : {}),
            };
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!meta) {
        throw new Error(`${file}: no defineDoc({...}) call found`);
    }
    return meta;
}

/**
 * `virtual:docs-meta`: title/category/description/order of every docs page, read statically from the
 * `defineDoc({...})` call, so the nav and search don't pull every page's demos into the main bundle.
 */
export function docsMeta(docsDir: string): Plugin {
    return {
        name: "glaze-docs-meta",
        resolveId: (id) => (id === ID ? RESOLVED : undefined),
        load(id) {
            if (id !== RESOLVED) {
                return undefined;
            }
            const files = readdirSync(docsDir).filter((f) => f.endsWith(".tsx"));
            const metas = files.map((f) => {
                const file = join(docsDir, f);
                this.addWatchFile(file);
                return extract(file, f.replace(/\.tsx$/, ""));
            });
            return `export default ${JSON.stringify(metas)};`;
        },
        // a docs page added, removed or retitled → refresh the manifest
        handleHotUpdate({file, server}) {
            if (file.startsWith(docsDir)) {
                const mod = server.moduleGraph.getModuleById(RESOLVED);
                if (mod) {
                    server.moduleGraph.invalidateModule(mod);
                }
            }
        },
    };
}
