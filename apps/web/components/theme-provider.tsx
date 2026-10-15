"use client";

import type { ComponentProps } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * `next-themes` is a client provider, so it is re-exported through a client
 * module and mounted from the server layout. That combination — a server
 * component tree with a client provider at the root — is the arrangement most
 * likely to break under a non-Next bundler, which is why M0 exercises it.
 */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
