import {useEffect} from "react";

export {SITE_THEME, THEME_KEY as THEME_STORAGE_KEY} from "./theme";

export const GITHUB_URL = "https://github.com/repraze/glaze";

export const NPM_URL = "https://www.npmjs.com/package/@repraze/glaze";

/** The brand as the nav and the tab show it. */
export const SITE_NAME = "GlazeEngine";

/** Sets the tab title: "Page · GlazeEngine", or the bare name on the home page. */
export function usePageTitle(title?: string) {
    useEffect(() => {
        document.title = title ? `${title} · ${SITE_NAME}` : SITE_NAME;
    }, [title]);
}
