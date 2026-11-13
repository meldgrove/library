import { describe, expect, it } from "vitest";
import { activeNavKey, breadcrumbsFor } from "./navigation";

describe("navigation", () => {
  it("marks the sidebar item of each page", () => {
    expect(activeNavKey("/")).toBe("library");
    expect(activeNavKey("/n/12")).toBe("library");
    expect(activeNavKey("/upload")).toBe("upload");
    expect(activeNavKey("/uploads")).toBe("uploads");
    expect(activeNavKey("/admin/taxonomy")).toBe("taxonomy");
    expect(activeNavKey("/review")).toBe("review");
    expect(activeNavKey("/steward")).toBe("steward");
    expect(activeNavKey("/settings")).toBeUndefined();
  });

  it("builds breadcrumbs from the section to the page", () => {
    expect(breadcrumbsFor("/")).toEqual([{ label: "Library" }]);
    expect(breadcrumbsFor("/n/12")).toEqual([{ label: "Library", href: "/" }, { label: "LIB-12" }]);
    expect(breadcrumbsFor("/n/12/edit")).toEqual([{ label: "Library", href: "/" }, { label: "LIB-12", href: "/n/12" }, { label: "Edit" }]);
    expect(breadcrumbsFor("/admin/people")).toEqual([{ label: "Admin", href: "/admin" }, { label: "People" }]);
    expect(breadcrumbsFor("/nowhere")).toEqual([]);
  });
});
