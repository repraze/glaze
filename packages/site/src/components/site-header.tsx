import {Button} from "@repraze/kernelkit/components/button";
import {Separator} from "@repraze/kernelkit/components/separator";
import {
    SiteHeader as SiteHeaderRoot,
    SiteHeaderActions,
    SiteHeaderBrand,
    SiteHeaderContent,
    SiteHeaderMenu,
    SiteNav,
    SiteNavLink,
} from "@repraze/kernelkit/components/site-header";
import {ThemeMenu} from "@repraze/kernelkit/components/theme-menu";
import {Link, useRouterState} from "@tanstack/react-router";
import {useEffect, useState} from "react";

import {DocsNav} from "@/components/docs-nav";
import {GithubIcon} from "@/components/github-icon";
import {Logo} from "@/components/logo";
import {SiteSearch} from "@/components/site-search";
import type {Category} from "@/lib/doc-kit";
import {DOCS_BY_SLUG} from "@/lib/docs-index";
import {GITHUB_URL, SITE_NAME} from "@/lib/site";

type Section = "docs" | "pipeline" | "scene" | "assets";

const NAV: {section: Section; slug: string; label: string}[] = [
    {section: "docs", slug: "introduction", label: "Docs"},
    {section: "pipeline", slug: "pass-chain", label: "Pipeline"},
    {section: "scene", slug: "scene-graph", label: "Scene"},
    {section: "assets", slug: "textures", label: "Assets"},
];

const SECTION_OF_CATEGORY: Record<Category, Section> = {
    Foundations: "docs",
    Pipeline: "pipeline",
    Scene: "scene",
    Assets: "assets",
};

/** Which header entry a docs page belongs to: one per docs category. */
function sectionOf(pathname: string): Section | undefined {
    const slug = /\/docs\/([^/]+)/.exec(pathname)?.[1];
    const doc = slug ? DOCS_BY_SLUG.get(slug) : undefined;
    return doc ? SECTION_OF_CATEGORY[doc.category] : undefined;
}

/** The suite's site header (kernelkit SiteHeader): brand, sections, search, theme, repository. */
export function SiteHeader() {
    const pathname = useRouterState({select: (s) => s.location.pathname});
    const section = sectionOf(pathname);
    const [menuOpen, setMenuOpen] = useState(false);
    useEffect(() => setMenuOpen(false), [pathname]);

    const navLinks = NAV.map((item) => (
        <SiteNavLink
            key={item.section}
            aria-current={item.section === section ? "page" : undefined}
            render={<Link to="/docs/$slug" params={{slug: item.slug}} />}
        >
            {item.label}
        </SiteNavLink>
    ));

    return (
        <SiteHeaderRoot>
            <SiteHeaderContent>
                <SiteHeaderMenu title={<Logo />} open={menuOpen} onOpenChange={setMenuOpen}>
                    <nav aria-label="Main" className="flex flex-col gap-1 px-2 pt-2">
                        {navLinks}
                    </nav>
                    <DocsNav />
                </SiteHeaderMenu>
                <SiteHeaderBrand aria-label={`${SITE_NAME} home`} render={<Link to="/" />}>
                    <Logo />
                </SiteHeaderBrand>
                <SiteNav>{navLinks}</SiteNav>
                <SiteHeaderActions>
                    <SiteSearch />
                    <Separator
                        orientation="vertical"
                        className="mx-1 hidden data-vertical:h-5 data-vertical:self-center sm:block"
                    />
                    <ThemeMenu />
                    <Button variant="ghost" size="icon" render={<a href={GITHUB_URL} aria-label="GitHub" />}>
                        <GithubIcon className="size-4" />
                    </Button>
                </SiteHeaderActions>
            </SiteHeaderContent>
        </SiteHeaderRoot>
    );
}
