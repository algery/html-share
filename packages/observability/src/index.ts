import { randomUUID } from "node:crypto";

export interface MetricSample {
  count: number;
  failures: number;
  maxMilliseconds: number;
  totalMilliseconds: number;
}

export interface Telemetry {
  record(input: { failed?: boolean; milliseconds?: number; name: string }): void;
  snapshot(): Readonly<Record<string, MetricSample>>;
}

const SECRET_KEY = /(?:authorization|code|cookie|secret|token|password|signature)/i;
const BODY_KEY = /(?:body|content|payload|archive)$/i;
const TRACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Generates an opaque correlation id; callers must not reuse credentials as trace ids. */
export function createTraceId(candidate?: string) {
  return candidate !== undefined && TRACE_ID.test(candidate) ? candidate : randomUUID();
}

/** Removes credential-like keys and truncates arbitrary values before structured logging. */
export function redactLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (typeof value !== "object" || value === null) return redactScalar(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SECRET_KEY.test(key) || BODY_KEY.test(key) ? "[REDACTED]" : redactLogValue(nested),
    ]),
  );
}

export function createTelemetry(): Telemetry {
  const samples = new Map<string, MetricSample>();
  return {
    record({ failed = false, milliseconds = 0, name }) {
      const sample = samples.get(name) ?? {
        count: 0,
        failures: 0,
        maxMilliseconds: 0,
        totalMilliseconds: 0,
      };
      sample.count += 1;
      sample.failures += failed ? 1 : 0;
      sample.maxMilliseconds = Math.max(sample.maxMilliseconds, milliseconds);
      sample.totalMilliseconds += milliseconds;
      samples.set(name, sample);
    },
    snapshot() {
      return Object.fromEntries([...samples].map(([name, sample]) => [name, { ...sample }]));
    },
  };
}

function redactScalar(value: unknown) {
  if (typeof value !== "string") return value;
  return value.length > 256 ? `${value.slice(0, 256)}…` : value;
}
