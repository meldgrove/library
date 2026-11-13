import type { FieldErrors } from "@/lib/commands";

/** What a form's Server Action returns when it does not redirect. */
export interface FormState {
  fieldErrors?: FieldErrors;
  formError?: string;
  /** Set when an action succeeded without redirecting. */
  done?: boolean;
}
