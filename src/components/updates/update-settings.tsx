"use client";

import { CircleAlert } from "lucide-react";
import { useId, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { automaticLine, stableDescription } from "@/lib/updates/state";
import { CHANNEL_LABELS, CHANNELS, type Channel } from "@/lib/updates/types";
import { updates, useUpdates } from "./use-updates";

const DEPLOYMENT_GUIDE = "https://github.com/meldgrove/library/blob/stable/docs/deployment.md#automatic-updates";

const PREVIEW_DESCRIPTION =
  "Unstable: every change on main as soon as its checks pass, before it is released. New features first, and now and then a new bug. Previews have no release notes.";

/** The "Updates" card on /admin: the installed version, the channel, and automatic installs. */
export function UpdateSettings() {
  const { response, saving } = useUpdates();
  const id = useId();
  const [choice, setChoice] = useState<Channel | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "done"; text: string } | null>(null);

  if (!response) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const updater = response.updater;
  const reachable = response.reachable && updater !== null;
  const current = updater?.channel ?? "stable";
  const selected = choice ?? current;
  const locked = updater?.channelLocked ?? null;
  const disabled = !reachable || locked !== null || saving;

  const save = async () => {
    setMessage(null);
    const error = await updates.setChannel(selected);
    setChoice(null);
    setMessage(error ? { tone: "error", text: error } : { tone: "done", text: `Channel: ${CHANNEL_LABELS[selected]}.` });
  };

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Installed version" value={response.app.version ?? "development"} />
        <Fact label="Channel" value={updater ? CHANNEL_LABELS[updater.channel] : "Unknown"} />
        {updater ? <Fact label="Automatic installs" value={<span className="font-normal">{automaticLine(updater)}</span>} /> : null}
      </dl>

      {!reachable ? (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            <p>
              The update service is not reachable. Automatic updates need the updater service from compose.yaml (
              <a href={DEPLOYMENT_GUIDE} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                deployment guide
              </a>
              ).
            </p>
            {response.error ? <p className="text-muted-foreground">{response.error}</p> : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <fieldset className="flex flex-col gap-3" disabled={disabled}>
        <legend className="mb-3 text-sm font-medium">Channel</legend>
        {locked ? <p className="text-sm text-muted-foreground">{locked}</p> : null}
        <RadioGroup value={selected} onValueChange={(value) => setChoice(value as Channel)} disabled={disabled} className="flex flex-col gap-3">
          {CHANNELS.map((channel) => (
            <div key={channel} className="flex items-start gap-3">
              <RadioGroupItem id={`${id}-${channel}`} value={channel} className="mt-0.5" />
              <div className="flex flex-col gap-1">
                <FieldLabel htmlFor={`${id}-${channel}`} className="font-normal">
                  {CHANNEL_LABELS[channel]}
                  {channel === "stable" ? <Badge variant="secondary">Recommended</Badge> : null}
                </FieldLabel>
                <FieldDescription>{channel === "stable" ? stableDescription(updater?.cooldown ?? null) : PREVIEW_DESCRIPTION}</FieldDescription>
              </div>
            </div>
          ))}
        </RadioGroup>
        <p className="text-sm text-muted-foreground">Switching back to Stable keeps this version until a release is newer.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={disabled || selected === current} onClick={() => void save()}>
            {saving ? "Saving…" : "Save channel"}
          </Button>
          <p role="status" className={message?.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {message?.text ?? ""}
          </p>
        </div>
      </fieldset>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
