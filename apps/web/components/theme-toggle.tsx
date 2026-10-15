"use client";

import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Monitor, Moon, Sun } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

/**
 * Theme switcher built on a real Radix DropdownMenu (portal, focus management,
 * keyboard navigation) rather than a native select, so that the Radix runtime
 * is genuinely exercised on the deployed Worker.
 */
export function ThemeToggle() {
  const t = useTranslations("ui");
  const locale = useLocale();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The server cannot know the resolved theme, so the first client render must
  // match the server output and only then reveal the actual value.
  useEffect(() => setMounted(true), []);

  const options = [
    { value: "light", label: t("themeLight"), Icon: Sun },
    { value: "dark", label: t("themeDark"), Icon: Moon },
    { value: "system", label: t("themeSystem"), Icon: Monitor },
  ] as const;

  return (
    <div className="flex flex-col gap-2" data-testid="theme-toggle">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button variant="outline" data-testid="theme-trigger">
            <Sun className="h-4 w-4 dark:hidden" aria-hidden />
            <Moon className="hidden h-4 w-4 dark:block" aria-hidden />
            {t("themeToggle")}
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="z-50 min-w-40 rounded-md border border-slate-200 bg-white p-1 shadow-md dark:border-slate-700 dark:bg-slate-900"
          >
            {options.map(({ value, label, Icon }) => (
              <DropdownMenu.Item
                key={value}
                onSelect={() => setTheme(value)}
                data-testid={`theme-option-${value}`}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100 dark:data-[highlighted]:bg-slate-800"
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
                {mounted && theme === value ? <span aria-hidden>✓</span> : null}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <p className="text-sm" data-testid="resolved-theme" data-locale={locale}>
        {mounted ? t("themeCurrent", { theme: resolvedTheme ?? "unknown" }) : t("themeCurrent", { theme: "…" })}
      </p>
    </div>
  );
}
