declare module "virtual:docs-meta" {
    const meta: {slug: string; title: string; category: string; description: string; order?: number}[];
    export default meta;
}
