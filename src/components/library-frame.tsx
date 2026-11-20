"use client";

import { AppFrame, type NavGroup } from "@meldgrove/ui/app-frame";
import { useThemePreference } from "@meldgrove/ui/theme";
import { UpdateButton } from "@meldgrove/ui/updates";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOutAction } from "@/app/actions";
import { LogoMark } from "@/components/logo";
import { findNotes, libraryHref } from "@/lib/library/search";
import { breadcrumbsFor, navSections, type NavKey } from "@/lib/navigation";

interface LibraryFrameProps {
  user: { name: string; email: string | null };
  /** Shows the Maintenance group: maintainers and admins. */
  canMaintain: boolean;
  /** Shows the Administration group: admins. */
  canAdminister: boolean;
  /** Admins see the update button (inside the layout's UpdatesProvider); false hides it (others, or UPDATER_URL empty). */
  updateButton: boolean;
  /** Shown as a count next to an item: things waiting for the person. */
  badges: Partial<Record<NavKey, number>>;
  /** The cookie `sidebar_state`, read on the server. */
  defaultSidebarOpen: boolean;
  children: React.ReactNode;
}

const search = { find: findNotes, allResultsHref: libraryHref };

function waiting(count: number | undefined): React.ReactNode {
  if (!count) return undefined;
  return (
    <>
      {count}
      <span className="sr-only"> waiting</span>
    </>
  );
}

/**
 * The frame of `@meldgrove/ui` with the library's navigation: a client
 * component, because the frame takes the router's link and functions, which
 * cannot come from the server layout.
 */
export function LibraryFrame({ user, canMaintain, canAdminister, updateButton, badges, defaultSidebarOpen, children }: LibraryFrameProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [theme, setTheme] = useThemePreference();
  const nav: NavGroup[] = navSections({ canMaintain, canAdminister }).map((section) => ({
    label: section.label,
    items: section.items.map(({ key, href, label, shortcut, match }) => ({ href, label, shortcut, match, badge: waiting(badges[key]) })),
  }));

  return (
    <AppFrame
      app={{ name: "Meldgrove Library", icon: <LogoMark />, description: "Shared reading" }}
      nav={nav}
      pathname={pathname}
      link={Link}
      navigate={(href) => router.push(href)}
      user={user}
      theme={theme}
      onThemeChange={setTheme}
      settingsHref="/settings"
      onSignOut={() => void signOutAction()}
      breadcrumbs={breadcrumbsFor(pathname)}
      headerEnd={updateButton ? <UpdateButton /> : null}
      search={search}
      defaultSidebarOpen={defaultSidebarOpen}
    >
      {children}
    </AppFrame>
  );
}
