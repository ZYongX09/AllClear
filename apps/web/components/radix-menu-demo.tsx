"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * A deliberately ordinary Radix DropdownMenu: portal, separator, a disabled
 * item, and translated labels. It is here to prove the Radix runtime and its
 * portal mount correctly under vinext, and that next-intl's client-side hook
 * works inside a Radix-rendered subtree.
 */
export function RadixMenuDemo() {
  const t = useTranslations("ui");

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="outline" data-testid="radix-trigger">
          {t("radixOpen")}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 min-w-48 rounded-md border border-slate-200 bg-white p-1 shadow-md dark:border-slate-700 dark:bg-slate-900"
        >
          <DropdownMenu.Item
            data-testid="radix-item-one"
            className="cursor-pointer rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100 dark:data-[highlighted]:bg-slate-800"
          >
            {t("radixItemOne")}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            data-testid="radix-item-two"
            className="cursor-pointer rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100 dark:data-[highlighted]:bg-slate-800"
          >
            {t("radixItemTwo")}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-slate-200 dark:bg-slate-700" />
          <DropdownMenu.Item
            disabled
            data-testid="radix-item-disabled"
            className="rounded-sm px-2 py-1.5 text-sm text-slate-400 dark:text-slate-600"
          >
            {t("radixDisabled")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
