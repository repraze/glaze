import {DocsNav, DocsSearch} from "@repraze/kernelkit/docs";
import {BrandLogo, SuiteHeader} from "@repraze/kernelkit/site";
import {Link, useNavigate, useRouterState} from "@tanstack/react-router";
import {BookOpenIcon, BoxIcon, ImageIcon, LayersIcon} from "lucide-react";

import type {Category} from "@/lib/doc-kit";
import {DOCS_INDEX} from "@/lib/docs-index";
import {GITHUB_URL, MARK_SVG, SITE_NAME} from "@/lib/site";

/** One icon per docs category, so a search result's kind reads at a glance. */
const CATEGORY_ICONS: Record<Category, typeof BookOpenIcon> = {
    Foundations: BookOpenIcon,
    Pipeline: LayersIcon,
    Scene: BoxIcon,
    Assets: ImageIcon,
};

/** One header entry per docs category, each opening its first page. */
const NAV: {category: Category; slug: string; label: string}[] = [
    {category: "Foundations", slug: "introduction", label: "Docs"},
    {category: "Pipeline", slug: "pass-chain", label: "Pipeline"},
    {category: "Scene", slug: "scene-graph", label: "Scene"},
    {category: "Assets", slug: "textures", label: "Assets"},
];

export const docLink = (slug: string) => <Link to="/docs/$slug" params={{slug}} />;

export const Logo = () => <BrandLogo svg={MARK_SVG} first="Glaze" second="Engine" />;

/** The docs sidebar (desktop SiteSidebar and the phone menu). */
export function SiteDocsNav() {
    const pathname = useRouterState({select: (s) => s.location.pathname});
    return <DocsNav index={DOCS_INDEX} current={DOCS_INDEX.slugOf(pathname)} linkFor={docLink} />;
}

/** The suite's header with GlazeEngine's brand, one entry per docs category and the docs search. */
export function SiteHeader() {
    const pathname = useRouterState({select: (s) => s.location.pathname});
    const navigate = useNavigate();
    const slug = DOCS_INDEX.slugOf(pathname);
    const category = slug ? DOCS_INDEX.bySlug.get(slug)?.category : undefined;
    return (
        <SuiteHeader
            brand={<Logo />}
            brandLabel={`${SITE_NAME} home`}
            home={<Link to="/" />}
            nav={NAV.map((item) => ({
                label: item.label,
                render: docLink(item.slug),
                current: item.category === category,
            }))}
            search={
                <DocsSearch
                    index={DOCS_INDEX}
                    icons={CATEGORY_ICONS}
                    suggested={["getting-started", "pass-chain", "deferred-scene-pass", "materials", "lights"]}
                    placeholder="Search the pipeline, scene and guides…"
                    onSelect={(slug) => void navigate({to: "/docs/$slug", params: {slug}})}
                />
            }
            repository={{href: GITHUB_URL}}
            menu={<SiteDocsNav />}
            locationKey={pathname}
        />
    );
}
