"use server";

import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { boundValues, handleFormAction as submit } from "@/lib/form-actions";
import type { FormState } from "@/lib/form-state";
import { SLACK_CHANNEL_ID_PATTERN } from "@/lib/library/constants";
import { setTeamDigestChannel } from "@/lib/library/digest";

/* Library settings of a team, with either directory. The command checks that the actor is an admin. */

const digestChannelSchema = z.object({
  channelId: z
    .string()
    .trim()
    .toUpperCase()
    .refine((value) => value === "" || SLACK_CHANNEL_ID_PATTERN.test(value), "Enter a Slack channel ID such as C0123456789, or leave it empty.")
    .transform((value) => value || null),
});

export async function setTeamDigestChannelAction(teamId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return submit(
    formData,
    digestChannelSchema,
    async (actor, input) => {
      await setTeamDigestChannel(getDb(), actor, teamId, input.channelId);
      return "/admin/teams";
    },
    boundValues.id.safeParse([teamId]),
  );
}
