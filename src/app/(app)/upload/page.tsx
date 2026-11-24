import { Alert, AlertDescription } from "@meldgrove/ui/alert";
import { Card, CardContent } from "@meldgrove/ui/card";
import { PageHeader } from "@meldgrove/ui/page";
import { CircleAlert } from "lucide-react";
import type { Metadata } from "next";
import { UploadForm } from "@/components/library/upload-form";
import { requireUser } from "@/lib/auth/session";
import { getStorageConfig, getUploadConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { NOTE_LIMITS, UPLOAD_CONFIRMATION, UPLOAD_RULES } from "@/lib/library/constants";
import { ACCEPT_ATTRIBUTE } from "@/lib/library/file-types";
import { latestWorkerChannels } from "@/lib/notifications/queries";

export const metadata: Metadata = { title: "Add to library" };

export default async function UploadPage() {
  await requireUser();
  const noModel = (await latestWorkerChannels(getDb()))?.ai === "off";
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader
        title="Add to library"
        description="Share a study, report, article, or funder material. An AI model drafts a note; you check it and publish it."
      />
      {noModel ? (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            No AI model is set up yet, so drafting waits. The library keeps what you add and drafts it once an admin sets up a model.
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent>
          <UploadForm
            accept={ACCEPT_ATTRIBUTE}
            maxMb={getUploadConfig().UPLOAD_MAX_MB}
            files={getStorageConfig().STORAGE_DRIVER !== "off"}
            rules={UPLOAD_RULES}
            confirmation={UPLOAD_CONFIRMATION}
            reasonMax={NOTE_LIMITS.reason}
          />
        </CardContent>
      </Card>
    </div>
  );
}
