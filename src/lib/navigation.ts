/*
 * The app's navigation: the sidebar items and the breadcrumb of each page.
 * Pure functions of the path, so the client components only render them.
 */

/** Shown above the other items, as the main action. */
export const UPLOAD = { key: "upload", href: "/upload", label: "Add to library" } as const;

export const MAIN_NAV = [
  { key: "library", href: "/", label: "Library" },
  { key: "review", href: "/review", label: "My review" },
  { key: "uploads", href: "/uploads", label: "My uploads" },
] as const;

export const ADMIN_NAV = [
  { key: "steward", href: "/steward", label: "Steward" },
  { key: "admin", href: "/admin", label: "Admin" },
  { key: "taxonomy", href: "/admin/taxonomy", label: "Taxonomy" },
  { key: "people", href: "/admin/people", label: "People" },
  { key: "teams", href: "/admin/teams", label: "Teams" },
] as const;

export type NavKey = typeof UPLOAD.key | (typeof MAIN_NAV)[number]["key"] | (typeof ADMIN_NAV)[number]["key"];

/** The sidebar item a page belongs to. Note pages belong to the library. */
export function activeNavKey(pathname: string): NavKey | undefined {
  if (pathname === "/" || pathname.startsWith("/n/")) return "library";
  if (pathname === "/upload") return "upload";
  if (pathname === "/uploads" || pathname.startsWith("/uploads/")) return "uploads";
  if (pathname === "/review") return "review";
  if (pathname === "/steward") return "steward";
  if (pathname === "/admin") return "admin";
  if (pathname === "/admin/taxonomy") return "taxonomy";
  if (pathname === "/admin/people") return "people";
  if (pathname === "/admin/teams") return "teams";
  return undefined;
}

export interface Crumb {
  label: string;
  /** Missing on the current page. */
  href?: string;
}

const ADMIN_PAGES: Record<string, string> = { taxonomy: "Taxonomy", people: "People", teams: "Teams" };

/** "LIB-12" for a note path segment such as "12". */
function noteCrumb(segment: string): string {
  return /^\d+$/.test(segment) ? `LIB-${segment}` : segment;
}

/** The breadcrumb shown in the header, from the section to the current page. */
export function breadcrumbsFor(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const [section, child] = segments;
  switch (section) {
    case undefined:
      return [{ label: "Library" }];
    case "upload":
      return [{ label: "Add to library" }];
    case "uploads":
      return [{ label: "My uploads" }];
    case "review":
      return [{ label: "My review" }];
    case "steward":
      return [{ label: "Steward" }];
    case "n": {
      if (!child) return [{ label: "Library" }];
      return segments[2] === "edit"
        ? [{ label: "Library", href: "/" }, { label: noteCrumb(child), href: `/n/${child}` }, { label: "Edit" }]
        : [{ label: "Library", href: "/" }, { label: noteCrumb(child) }];
    }
    case "admin": {
      const page = child ? ADMIN_PAGES[child] : undefined;
      return page ? [{ label: "Admin", href: "/admin" }, { label: page }] : [{ label: "Admin" }];
    }
    case "settings":
      return [{ label: "Settings" }];
    default:
      return [];
  }
}
