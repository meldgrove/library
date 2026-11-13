import type { Metadata } from "next";
import { PreferencesForm } from "@/components/settings/preferences-form";
import { SubscriptionsForm } from "@/components/settings/subscriptions-form";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { subscriptionOptions } from "@/lib/library/subscriptions";
import { DATE_FORMAT_LABELS, DATE_FORMATS, SERVER_TIME_ZONE, timeZoneOptions } from "@/lib/preferences";
import { savePreferencesAction, saveTagSubscriptionsAction } from "./actions";

export const metadata: Metadata = { title: "Settings" };

/** The signed-in person's own display preferences and the tags they follow. */
export default async function SettingsPage() {
  const { person } = await requireUser();
  const fmt = await getFormatter();
  const subscriptions = await subscriptionOptions(getDb(), person.id);
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader
        title="Settings"
        description={`How the library shows dates and times to you. Deadlines always end at 23:59 in ${SERVER_TIME_ZONE}, the time zone of this library.`}
      />
      <Card>
        <CardContent>
          <PreferencesForm
            action={savePreferencesAction}
            timeZone={person.timeZone}
            dateFormat={fmt.dateFormat}
            serverTimeZone={SERVER_TIME_ZONE}
            timeZones={timeZoneOptions()}
            dateFormats={DATE_FORMATS.map((value) => ({ value, label: DATE_FORMAT_LABELS[value] }))}
            example={fmt.dateTime(new Date())}
          />
        </CardContent>
      </Card>
      <Card role="region" aria-labelledby="weekly-email">
        <CardHeader>
          <CardTitle>
            <h2 id="weekly-email">Weekly email</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SubscriptionsForm action={saveTagSubscriptionsAction} tagGroups={subscriptions.tagGroups} followed={subscriptions.followed} />
        </CardContent>
      </Card>
    </div>
  );
}
