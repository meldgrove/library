import { cn } from "@meldgrove/ui/utils";

const BOOKS_PATH = "M9.5 9v14M14.5 9v14M19.5 10l4 12.5";

/** The library mark, books on a shelf, as in the app icon (`src/app/icon.svg`). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true" className={cn("size-8", className)}>
      <rect width="32" height="32" rx="7" fill="#171717" />
      <path d={BOOKS_PATH} fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The books of the mark alone, in the current color, for the square that the
 * app frame and the sign-in page draw. Its box is the middle half of the app
 * icon, so a square twice its size looks like the icon.
 */
export function LogoMark() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="8 8 16 16" overflow="visible" aria-hidden="true">
      <path d={BOOKS_PATH} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}
