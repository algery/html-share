import type { CSSProperties } from "react";

const paths = {
  code: "m6 5-4 3 4 3m4-6 4 3-4 3M9 3 7 13",
  search: "M11 11l3 3M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z",
  refresh: "M13 5a5.5 5.5 0 1 0 .4 5M13 1v4H9",
  arrow: "M4 12 12 4M4 4h8v8",
} as const;
export function ManagementIcon({
  name,
  className = "",
  style,
}: {
  name: keyof typeof paths;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
