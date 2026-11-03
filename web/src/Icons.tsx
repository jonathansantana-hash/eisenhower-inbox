import type { ReactNode } from "react";

export type IconName =
  | "users" | "bolt" | "trash" | "calendar" | "trophy" | "chart" | "doc" | "ban"
  | "target" | "list" | "search" | "plus" | "x" | "slack" | "check" | "inbox" | "logout" | "gear";

const PATHS: Record<IconName, ReactNode> = {
  users: (
    <>
      <circle cx="12" cy="7.5" r="3.2" />
      <circle cx="5.5" cy="9" r="2.4" />
      <circle cx="18.5" cy="9" r="2.4" />
      <path d="M6.5 19c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5z" />
      <path d="M1.5 18.5c0-2.6 1.7-4.3 4-4.3 1 0 1.8.3 2.5.8-1 1-1.6 2.3-1.8 3.5zM22.5 18.5c0-2.6-1.7-4.3-4-4.3-1 0-1.8.3-2.5.8 1 1 1.6 2.3 1.8 3.5z" />
    </>
  ),
  bolt: <path d="M13.5 2 4.5 13.5h6L9.5 22l10-12.5h-6.2z" />,
  trash: (
    <path d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7zm3 2v8h1.6v-8zm4.4 0v8H15v-8z" />
  ),
  calendar: (
    <path d="M7 2h2v2h6V2h2v2h3v17H4V4h3zm-1 7v10h12V9zm2 2h2v2H8zm3 0h2v2h-2zm3 0h2v2h-2zm-6 3h2v2H8zm3 0h2v2h-2zm3 0h2v2h-2z" />
  ),
  trophy: (
    <path d="M7 3h10v2h3v3a4 4 0 0 1-4.2 4A5 5 0 0 1 13 14.9V17h3v2H8v-2h3v-2.1A5 5 0 0 1 8.2 12 4 4 0 0 1 4 8V5h3zm0 4H6v1a2 2 0 0 0 1.3 1.9A7 7 0 0 1 7 8zm10 0v1c0 .7 0 1.3-.3 1.9A2 2 0 0 0 18 8V7zM7 20h10v2H7z" />
  ),
  chart: <path d="M4 20V13h3v7zm5.5 0V9h3v11zm5.5 0V5h3v15zM3 21h18v1.5H3z" />,
  doc: (
    <path d="M6 2h8l5 5v15H6zm7 1.5V8h4.5zM8.5 11v1.5h8V11zm0 3.5V16h8v-1.5zm0 3.5v1.5h5V18z" />
  ),
  ban: (
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2.5c1.7 0 3.3.6 4.6 1.5L6 16.6A7.5 7.5 0 0 1 12 4.5zm0 15c-1.7 0-3.3-.6-4.6-1.5L18 7.4a7.5 7.5 0 0 1-6 12.1z" />
  ),
  target: (
    <>
      <path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7z" />
      <path d="M12 7a5 5 0 1 0 5 5h-2a3 3 0 1 1-3-3z" />
      <path d="M11 11.5 19 4l1 1-8 7.5zM18 2l.5 3 3 .5-2.5 2.5-3-.5-.5-3z" />
    </>
  ),
  list: <path d="M3 5h2.5v2.5H3zm5 .5h13v1.5H8zM3 10.8h2.5v2.5H3zm5 .5h13v1.5H8zM3 16.5h2.5V19H3zm5 .5h13v1.5H8z" />,
  search: <path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z" />,
  plus: <path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z" />,
  x: <path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z" />,
  check: <path d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 11-11-1.4-1.4z" />,
  inbox: <path d="M4 4h16l2 9v7H2v-7zm1.6 2-1.5 7H8l1.5 2.5h5L16 13h3.9l-1.5-7z" />,
  slack: (
    <path d="M9 3a2 2 0 0 0 0 4h2V5a2 2 0 0 0-2-2zm0 5.5H4a2 2 0 0 0 0 4h5a2 2 0 0 0 0-4zM21 10.5a2 2 0 0 0-4 0v2h2a2 2 0 0 0 2-2zm-5.5 0V5a2 2 0 0 0-4 0v5.5a2 2 0 0 0 4 0zM15 21a2 2 0 0 0 0-4h-2v2a2 2 0 0 0 2 2zm0-5.5h5a2 2 0 0 0 0-4h-5a2 2 0 0 0 0 4zM3 13.5a2 2 0 0 0 4 0v-2H5a2 2 0 0 0-2 2zm5.5 0V19a2 2 0 0 0 4 0v-5.5a2 2 0 0 0-4 0z" />
  ),
  gear: (
    <path d="M10.3 2h3.4l.5 2.6c.6.2 1.2.5 1.7.9l2.5-.9 1.7 2.9-2 1.8a7 7 0 0 1 0 2l2 1.8-1.7 2.9-2.5-.9c-.5.4-1.1.7-1.7.9l-.5 2.6h-3.4l-.5-2.6c-.6-.2-1.2-.5-1.7-.9l-2.5.9-1.7-2.9 2-1.8a7 7 0 0 1 0-2l-2-1.8 1.7-2.9 2.5.9c.5-.4 1.1-.7 1.7-.9zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />
  ),
  logout: <path d="M4 3h9v2H6v14h7v2H4zm12.6 4.4L21.2 12l-4.6 4.6-1.4-1.4 2.2-2.2H9v-2h8.4l-2.2-2.2z" />,
};

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" className={className}>
      {PATHS[name]}
    </svg>
  );
}
