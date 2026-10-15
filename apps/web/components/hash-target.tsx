"use client";

import { useEffect } from "react";

/**
 * Open the disclosure that an anchor points at.
 *
 * A fragment scrolls to the element carrying that id, but a browser will not
 * open a closed `<details>` to show you what you asked for. So a permalink to an
 * incident that has since been resolved lands on a collapsed summary and leaves
 * the reader to click it — which is not a deep link, it is a deep link with one
 * step missing.
 *
 * This has to run on the client, and after hydration: `<details>` has no
 * attribute meaning "open when targeted", and there is no CSS for it either. The
 * alternative — rendering every entry open — throws away the reason the entries
 * are disclosures in the first place.
 *
 * It also listens for `hashchange`, because following a permalink from inside
 * the same page is a fragment change rather than a load.
 */
export function HashTargetOpener() {
  useEffect(() => {
    const openTargeted = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (id === "") return;
      const target = document.getElementById(id);
      const disclosure = target?.querySelector("details");
      if (disclosure) disclosure.open = true;
    };

    openTargeted();
    window.addEventListener("hashchange", openTargeted);
    return () => window.removeEventListener("hashchange", openTargeted);
  }, []);

  return null;
}
