import type { Metadata } from "next";
import { UploadForm } from "@/components/library/upload-form";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/session";
import { getUploadConfig } from "@/lib/config";
import { NOTE_LIMITS, UPLOAD_CONFIRMATION, UPLOAD_RULES } from "@/lib/library/constants";
import { ACCEPT_ATTRIBUTE } from "@/lib/library/file-types";

export const metadata: Metadata = { title: "Add to library" };

export default async function UploadPage() {
  await requireUser();
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader
        title="Add to library"
        description="Share a study, report, article, or funder material. An AI model drafts a note; you check it and publish it."
      />
      <Card>
        <CardContent>
          <UploadForm
            accept={ACCEPT_ATTRIBUTE}
            maxMb={getUploadConfig().UPLOAD_MAX_MB}
            rules={UPLOAD_RULES}
            confirmation={UPLOAD_CONFIRMATION}
            reasonMax={NOTE_LIMITS.reason}
          />
        </CardContent>
      </Card>
    </div>
  );
}
