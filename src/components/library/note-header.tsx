import { PageHeader } from "@meldgrove/ui/page";
import { noteRef } from "@/lib/library/constants";

/** A note page's header: its reference (LIB-12) above the title, which wraps (the package's header keeps a title on one line). */
export function NoteHeader({ number, title, actions }: { number: number; title: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted-foreground">{noteRef(number)}</span>
      <PageHeader title={<span className="whitespace-normal wrap-anywhere">{title}</span>} actions={actions} />
    </div>
  );
}
