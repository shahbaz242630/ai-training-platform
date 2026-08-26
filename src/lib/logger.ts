/**
 * Structured logger with mandatory redaction.
 *
 * Rule: never log tokens, keys, full payment details or unnecessary personal
 * data. Relying on every future call site to remember that is not a control, so
 * redaction happens here on the way out and cannot be bypassed by forgetting.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Key names whose values are replaced wholesale, matched case-insensitively. */
const REDACTED_KEYS = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "sessionid",
  "session_id",
  "clientsecret",
  "client_secret",
  "servicerolekey",
  "card",
  "cardnumber",
  "cvv",
  "cvc",
  "iban",
  "pan",
];

export const REDACTED = "[redacted]";

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z]/g, "");
  return REDACTED_KEYS.some((k) => normalised.includes(k.replace(/[^a-z]/g, "")));
}

/**
 * Emails are personal data but are often the only way to correlate a booking
 * problem with a customer, so they are masked rather than removed entirely:
 * `ada@example.com` becomes `a**@example.com`.
 */
export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at < 1) return REDACTED;
  const first = value[0] ?? "";
  return `${first}**${value.slice(at)}`;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[max depth]";

  if (typeof value === "string") {
    return value.replace(EMAIL_PATTERN, (match) => maskEmail(match));
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: String(redact(value.message, depth + 1)) };
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return output;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

/** Swappable so tests can assert output without touching the console. */
export type LogSink = (record: LogRecord & { timestamp: string }) => void;

const consoleSink: LogSink = (record) => {
  // JSON lines: greppable in aggregators, and never interpolates user input
  // into a format string.
  const line = JSON.stringify(record);
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
};

let sink: LogSink = consoleSink;

export function setLogSink(next: LogSink): void {
  sink = next;
}

export function resetLogSink(): void {
  sink = consoleSink;
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  sink({
    level,
    message,
    ...(context ? { context: redact(context) as Record<string, unknown> } : {}),
    // Injected at call time rather than by the sink so tests can freeze it.
    timestamp: new Date().toISOString(),
  });
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};
