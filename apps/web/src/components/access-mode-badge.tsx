export function AccessModeBadge({ mode }: { mode: "organization" | "password" }) {
  return (
    <span
      className={`inline-flex shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${
        mode === "password" ? "bg-amber-100 text-amber-900" : "bg-blue-50 text-blue-800"
      }`}
    >
      {mode === "password" ? "密码访问" : "组织访问"}
    </span>
  );
}
