/*
 * The app's navigation: the sidebar items and the breadcrumb of each page.
 * Pure data and functions of the path; `LibraryFrame` hands them to the
 * frame of `@meldgrove/ui`, which marks the current item.
 */

export type NavKey = "library" | "review" | "uploads" | "maintenance" | "taxonomy" | "admin" | "people" | "teams";

export interface NavLink {
  key: NavKey;
  href: string;
  label: string;
  /** "G then this letter" opens the page: main pages only, each letter once; "o" is the start page. */
  shortcut?: string;
  /** More paths whose pages belong to this item, with their sub-pages. */
  match?: string[];
}

export interface NavSection {
  label?: string;
  items: NavLink[];
}

/**
 * The main pages. Notes (/n/…) and "Add to library" (/upload) belong to the
 * library; "Add to library" itself is a button in the headers of the library
 * and of My uploads.
 */
export const MAIN_NAV: NavLink[] = [
  { key: "library", href: "/", label: "Library", shortcut: "o", match: ["/n", "/upload"] },
  { key: "review", href: "/review", label: "My review", shortcut: "r" },
  { key: "uploads", href: "/uploads", label: "My uploads", shortcut: "u" },
];

/** For maintainers (and admins): looking after the content. Maintenance is their main page. */
export const MAINTENANCE_NAV: NavLink[] = [
  { key: "maintenance", href: "/maintenance", label: "Maintenance", shortcut: "m" },
  { key: "taxonomy", href: "/maintenance/taxonomy", label: "Taxonomy" },
];

/** For admins: running the app. */
export const ADMIN_NAV: NavLink[] = [
  { key: "admin", href: "/admin", label: "Admin" },
  { key: "people", href: "/admin/people", label: "People" },
  { key: "teams", href: "/admin/teams", label: "Teams" },
];

/** The sidebar of a person: the main pages, then Maintenance for maintainers and Administration for admins. */
export function navSections({ canMaintain, canAdminister }: { canMaintain: boolean; canAdminister: boolean }): NavSection[] {
  return [
    { items: MAIN_NAV },
    ...(canMaintain ? [{ label: "Maintenance", items: MAINTENANCE_NAV }] : []),
    ...(canAdminister ? [{ label: "Administration", items: ADMIN_NAV }] : []),
  ];
}

export interface Crumb {
  label: string;
  /** Missing on the current page. */
  href?: string;
}

const LIBRARY: Crumb = { label: "Library", href: "/" };
const MAINTENANCE_PAGES: Record<string, string> = { taxonomy: "Taxonomy" };
const ADMIN_PAGES: Record<string, string> = { people: "People", teams: "Teams" };

/** "LIB-12" for a note path segment such as "12". */
function noteCrumb(segment: string): string {
  return /^\d+$/.test(segment) ? `LIB-${segment}` : segment;
}

/** The breadcrumb shown in the header, from the sidebar section to the current page (at most three steps). */
export function breadcrumbsFor(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const [section, child] = segments;
  switch (section) {
    case undefined:
      return [{ label: "Library" }];
    case "upload":
      return [LIBRARY, { label: "Add to library" }];
    case "uploads":
      return [{ label: "My uploads" }];
    case "review":
      return [{ label: "My review" }];
    case "maintenance": {
      const page = child ? MAINTENANCE_PAGES[child] : undefined;
      return page ? [{ label: "Maintenance", href: "/maintenance" }, { label: page }] : [{ label: "Maintenance" }];
    }
    case "n": {
      if (!child) return [LIBRARY];
      return segments[2] === "edit"
        ? [LIBRARY, { label: noteCrumb(child), href: `/n/${child}` }, { label: "Edit" }]
        : [LIBRARY, { label: noteCrumb(child) }];
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
