export class AccountLinkError extends Error {
  constructor(readonly code: "ACCOUNT_LINK_CONFLICT" | "ACCOUNT_DISABLED") {
    super(code);
    this.name = "AccountLinkError";
  }
}

/** Only fresh, server-supplied snapshots participate in first-time linking. */
export function accountContactCutoff(now: Date) {
  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
}

export function normalizeAccountContacts(input: { phone?: string; email?: string }) {
  return { phone: normalizePhone(input.phone), email: normalizeEmail(input.email) };
}

function normalizePhone(value: string | undefined): string | null {
  if (!value || value.length > 64 || !/^[+\d\s().-]+$/.test(value)) return null;
  let phone = value.replace(/[\s().-]/g, "");
  if (/^1[3-9]\d{9}$/.test(phone)) phone = `+86${phone}`;
  if (/^861[3-9]\d{9}$/.test(phone)) phone = `+${phone}`;
  if (/^00[1-9]/.test(phone)) phone = `+${phone.slice(2)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return null;
  if (phone.startsWith("+86") && !/^\+861[3-9]\d{9}$/.test(phone)) return null;
  return phone;
}

function normalizeEmail(value: string | undefined): string | null {
  if (!value) return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || /[*•●…]/u.test(email)) return null;
  const parts = email.split("@");
  const local = parts[0] ?? "",
    domain = parts[1] ?? "";
  if (parts.length !== 2 || local.length > 64 || !/^[a-z0-9!#$%&'+/=?^_`{|}~.-]+$/.test(local))
    return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (
    !domain.includes(".") ||
    !domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  return email;
}
