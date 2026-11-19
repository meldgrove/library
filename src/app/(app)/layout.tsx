import { cookies } from "next/headers";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { requireUser } from "@/lib/auth/session";
import { getUpdaterConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { countMyDrafts, countStewardWork } from "@/lib/library/review";
import { displayPreferences } from "@/lib/preferences";

/** Set by the sidebar (`src/components/ui/sidebar.tsx`) when it is opened or collapsed. */
const SIDEBAR_COOKIE = "sidebar_state";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { person } = await requireUser();
  const [cookieStore, drafts, stewardWork] = await Promise.all([
    cookies(),
    countMyDrafts(getDb(), person.id),
    person.isAdmin ? countStewardWork(getDb()) : Promise.resolve(0),
  ]);
  // The update button: admins only, and off when UPDATER_URL is empty.
  const updates = person.isAdmin && getUpdaterConfig().UPDATER_URL !== null ? { preferences: displayPreferences(person) } : null;
  return (
    <SidebarProvider defaultOpen={cookieStore.get(SIDEBAR_COOKIE)?.value !== "false"}>
      <AppSidebar user={{ name: person.displayName, email: person.workEmail }} isAdmin={person.isAdmin} badges={{ review: drafts, steward: stewardWork }} />
      <SidebarInset className="min-w-0">
        <AppHeader updates={updates} />
        <div className="flex-1 px-4 py-6 md:px-8">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
