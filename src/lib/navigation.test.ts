import { describe, expect, it } from "vitest";
import { breadcrumbsFor, navSections } from "./navigation";

const labels = (sections: ReturnType<typeof navSections>) => sections.flatMap((section) => section.items.map((item) => item.label));

describe("navSections", () => {
  it("shows Maintenance to maintainers and Administration to admins only", () => {
    expect(labels(navSections({ canMaintain: false, canAdminister: false }))).toEqual(["Library", "My review", "My uploads"]);
    expect(navSections({ canMaintain: true, canAdminister: false }).map((section) => section.label)).toEqual([undefined, "Maintenance"]);
    expect(navSections({ canMaintain: true, canAdminister: true }).map((section) => section.label)).toEqual([
      undefined,
      "Maintenance",
      "Administration",
    ]);
  });

  it("gives the main pages a key each, with o for the library, and none to the taxonomy and admin pages", () => {
    const items = navSections({ canMaintain: true, canAdminister: true }).flatMap((section) => section.items);
    expect(items.filter((item) => item.shortcut).map((item) => [item.shortcut, item.label])).toEqual([
      ["o", "Library"],
      ["r", "My review"],
      ["u", "My uploads"],
      ["m", "Maintenance"],
    ]);
  });

  it("keeps the main action out of the sidebar", () => {
    const items = navSections({ canMaintain: true, canAdminister: true }).flatMap((section) => section.items);
    expect(items.map((item) => item.href)).not.toContain("/upload");
    expect(items.map((item) => item.label)).not.toContain("Add to library");
  });

  it("lets notes and Add to library belong to the library", () => {
    expect(navSections({ canMaintain: false, canAdminister: false })[0]!.items[0]).toMatchObject({ href: "/", match: ["/n", "/upload"] });
  });
});

describe("breadcrumbsFor", () => {
  it.each([
    ["/", [{ label: "Library" }]],
    ["/upload", [{ label: "Library", href: "/" }, { label: "Add to library" }]],
    ["/uploads", [{ label: "My uploads" }]],
    ["/review", [{ label: "My review" }]],
    ["/n/12", [{ label: "Library", href: "/" }, { label: "LIB-12" }]],
    ["/n/12/edit", [{ label: "Library", href: "/" }, { label: "LIB-12", href: "/n/12" }, { label: "Edit" }]],
    ["/maintenance", [{ label: "Maintenance" }]],
    ["/maintenance/taxonomy", [{ label: "Maintenance", href: "/maintenance" }, { label: "Taxonomy" }]],
    ["/admin", [{ label: "Admin" }]],
    ["/admin/people", [{ label: "Admin", href: "/admin" }, { label: "People" }]],
    ["/settings", [{ label: "Settings" }]],
    ["/nowhere", []],
  ])("%s", (pathname, crumbs) => {
    expect(breadcrumbsFor(pathname)).toEqual(crumbs);
  });
});
