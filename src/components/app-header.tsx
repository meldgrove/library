"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@meldgrove/ui/breadcrumb";
import { Separator } from "@meldgrove/ui/separator";
import { SidebarTrigger } from "@meldgrove/ui/sidebar";
import { UpdateButton } from "@meldgrove/ui/updates";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { breadcrumbsFor } from "@/lib/navigation";

interface AppHeaderProps {
  /** Admins see the update button (inside the layout's UpdatesProvider); false hides it (others, or UPDATER_URL empty). */
  updateButton: boolean;
}

/** The sidebar toggle, where the page sits in the app, and the update button for admins. */
export function AppHeader({ updateButton }: AppHeaderProps) {
  const crumbs = breadcrumbsFor(usePathname());
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      {crumbs.length > 0 ? (
        <>
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              {crumbs.map((crumb, index) => (
                <Fragment key={crumb.label}>
                  {index > 0 ? <BreadcrumbSeparator /> : null}
                  <BreadcrumbItem>
                    {crumb.href ? (
                      <BreadcrumbLink asChild>
                        <Link href={crumb.href}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </>
      ) : null}
      {updateButton ? (
        <div className="ml-auto flex shrink-0 items-center">
          <UpdateButton />
        </div>
      ) : null}
    </header>
  );
}
