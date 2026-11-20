import { Page } from "@meldgrove/ui/page";
import { UpdatesProvider } from "@meldgrove/ui/updates";
import { cookies } from "next/headers";
import { LibraryFrame } from "@/components/library-frame";
import { canAdminister, canMaintain } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { getUpdaterConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { countMyDrafts, countMaintenanceWork } from "@/lib/library/review";
import { displayPreferences, type DateFormat } from "@/lib/preferences";
import { UPDATES_API } from "@/lib/updates/types";

/** Set by the frame's sidebar when it is opened or hidden. */
const SIDEBAR_COOKIE = "sidebar_state";

const DEPLOYMENT_GUIDE = "https://github.com/meldgrove/library/blob/stable/docs/deployment.md#automatic-updates";

/** The locale whose dates read like each date format; en-GB (19 Nov 2026) for YYYY-MM-DD. */
const DATE_LOCALES: Record<DateFormat, string> = {
  "DD.MM.YYYY": "de-DE",
  "YYYY-MM-DD": "en-GB",
  "DD/MM/YYYY": "en-GB",
  "MM/DD/YYYY": "en-US",
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { person } = await requireUser();
  const [cookieStore, drafts, maintenanceWork] = await Promise.all([
    cookies(),
    countMyDrafts(getDb(), person.id),
    canMaintain(person.role) ? countMaintenanceWork(getDb()) : Promise.resolve(0),
  ]);
  const admin = canAdminister(person.role);
  const frame = (
    <LibraryFrame
      user={{ name: person.displayName, email: person.workEmail }}
      canMaintain={canMaintain(person.role)}
      canAdminister={admin}
      // The update button: admins only, and off when UPDATER_URL is empty.
      updateButton={admin && getUpdaterConfig().UPDATER_URL !== null}
      badges={{ review: drafts, maintenance: maintenanceWork }}
      defaultSidebarOpen={cookieStore.get(SIDEBAR_COOKIE)?.value !== "false"}
    >
      {/* The library's reading width: notes are mostly text. */}
      <Page className="max-w-5xl">{children}</Page>
    </LibraryFrame>
  );
  if (!admin) return frame;
  return (
    // The update button in the header and the Updates card on /admin share one status.
    <UpdatesProvider
      appName="Meldgrove Library"
      project="library"
      url={UPDATES_API}
      guideUrl={DEPLOYMENT_GUIDE}
      // Dates in the person's date format and time zone, as everywhere in the app.
      dateLocale={DATE_LOCALES[displayPreferences(person).dateFormat]}
      timeZone={displayPreferences(person).timeZone}
    >
      {frame}
    </UpdatesProvider>
  );
}
