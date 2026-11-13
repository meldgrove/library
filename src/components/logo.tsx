import { cn } from "@/lib/utils";

/** The library mark, books on a shelf, as in the app icon (`src/app/icon.svg`). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true" className={cn("size-8", className)}>
      <rect width="32" height="32" rx="7" fill="#171717" />
      <path d="M9.5 9v14M14.5 9v14M19.5 10l4 12.5" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}
