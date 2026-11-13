"use client";

import { CloudUpload, FileCheck2, FileUp, Link2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

interface UploadFormProps {
  accept: string;
  maxMb: number;
  rules: readonly string[];
  confirmation: string;
  reasonMax: number;
}

type Errors = { formError?: string; fieldErrors?: Record<string, string> };

/** A file or a link, one line on why, and the confirmation of the upload rules. Posts to /api/uploads. */
export function UploadForm({ accept, maxMb, rules, confirmation, reasonMax }: UploadFormProps) {
  const router = useRouter();
  const id = useId();
  const [kind, setKind] = useState<"file" | "link">("file");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [fileName, setFileName] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const fieldError = (name: string) => errors.fieldErrors?.[name];

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set("kind", kind);
    const file = data.get("file");
    if (kind === "file" && file instanceof File && file.size > maxMb * 1_048_576) {
      setErrors({ fieldErrors: { file: `The file is larger than ${maxMb} MB.` } });
      return;
    }
    setPending(true);
    setErrors({});
    try {
      const response = await fetch("/api/uploads", { method: "POST", body: data });
      if (response.ok) {
        router.push("/uploads?added=1");
        router.refresh();
        return;
      }
      setErrors(((await response.json().catch(() => null)) as Errors | null) ?? { formError: `The upload failed (HTTP ${response.status}).` });
    } catch {
      setErrors({ formError: "The upload failed. Check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      {errors.formError ? (
        <Alert variant="destructive">
          <AlertDescription>{errors.formError}</AlertDescription>
        </Alert>
      ) : null}

      <ToggleGroup
        type="single"
        variant="outline"
        value={kind}
        onValueChange={(value) => {
          if (!value) return;
          setKind(value as "file" | "link");
          setFileName(undefined);
        }}
        aria-label="What to add"
        className="w-fit"
      >
        <ToggleGroupItem value="file" aria-label="A file">
          <FileUp aria-hidden="true" /> File
        </ToggleGroupItem>
        <ToggleGroupItem value="link" aria-label="A link">
          <Link2 aria-hidden="true" /> Link
        </ToggleGroupItem>
      </ToggleGroup>

      {kind === "file" ? (
        <Field data-invalid={fieldError("file") ? true : undefined}>
          <FieldLabel htmlFor={`${id}-file`}>File</FieldLabel>
          {/* The input covers the whole area, so clicking and dropping a file need no script. */}
          <div
            className={cn(
              "relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-input bg-muted/20 px-6 py-10 text-center transition-colors hover:border-foreground/30 hover:bg-muted/40",
              "has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-[3px] has-[input:focus-visible]:ring-ring/50",
              dragging && "border-primary bg-primary/5",
              fieldError("file") && "border-destructive",
            )}
          >
            <input
              id={`${id}-file`}
              name="file"
              type="file"
              accept={accept}
              required
              aria-invalid={fieldError("file") ? true : undefined}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
              onChange={(event) => setFileName(event.currentTarget.files?.[0]?.name)}
              onDragEnter={() => setDragging(true)}
              onDragLeave={() => setDragging(false)}
              onDrop={() => setDragging(false)}
            />
            <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-full border bg-background shadow-xs">
              {fileName ? <FileCheck2 className="size-5 text-emerald-600" /> : <CloudUpload className="size-5 text-muted-foreground" />}
            </span>
            {fileName ? (
              <span className="text-sm font-medium break-all">{fileName}</span>
            ) : (
              <span className="text-sm">
                <span className="font-medium">Choose a file</span> <span className="text-muted-foreground">or drag it here</span>
              </span>
            )}
          </div>
          <FieldDescription>PDF, Word (.docx), web page, or text file, up to {maxMb} MB.</FieldDescription>
          <FieldError>{fieldError("file")}</FieldError>
        </Field>
      ) : (
        <Field data-invalid={fieldError("url") ? true : undefined}>
          <FieldLabel htmlFor={`${id}-url`}>Link</FieldLabel>
          <Input id={`${id}-url`} name="url" type="url" inputMode="url" placeholder="https://" required aria-invalid={fieldError("url") ? true : undefined} />
          <FieldDescription>A web page or a PDF. The library downloads it and keeps a copy of the text.</FieldDescription>
          <FieldError>{fieldError("url")}</FieldError>
        </Field>
      )}

      <Field data-invalid={fieldError("reason") ? true : undefined}>
        <FieldLabel htmlFor={`${id}-reason`}>Why is it useful?</FieldLabel>
        <Textarea id={`${id}-reason`} name="reason" rows={2} maxLength={reasonMax} required placeholder="One line, e.g. “Numbers on heat plans for the Climate Lab”" aria-invalid={fieldError("reason") ? true : undefined} />
        <FieldDescription>Goes into the note and helps the AI pick tags.</FieldDescription>
        <FieldError>{fieldError("reason")}</FieldError>
      </Field>

      <section aria-labelledby={`${id}-rules`} className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-50 p-4 dark:bg-amber-950/30">
        <h2 id={`${id}-rules`} className="text-sm font-medium">
          Upload rules
        </h2>
        <ul className="list-disc pl-5 text-sm">
          {rules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <Field orientation="horizontal" data-invalid={fieldError("confirmed") ? true : undefined}>
          <Checkbox id={`${id}-confirmed`} name="confirmed" required className="bg-background" aria-invalid={fieldError("confirmed") ? true : undefined} />
          <FieldContent>
            <FieldLabel htmlFor={`${id}-confirmed`} className="font-normal">
              {confirmation}
            </FieldLabel>
            <FieldError>{fieldError("confirmed")}</FieldError>
          </FieldContent>
        </Field>
      </section>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Uploading…" : "Add to library"}
        </Button>
      </div>
    </form>
  );
}
