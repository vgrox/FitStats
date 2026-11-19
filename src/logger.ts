type LogFields = Record<string, boolean | number | string | null | undefined>;

const sensitiveField = /token|secret|authorization|cookie|password|code/i;

function redact(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, sensitiveField.test(key) ? "[redacted]" : value])
  );
}

function write(level: "info" | "warn" | "error", message: string, fields: LogFields = {}): void {
  console[level](JSON.stringify({ time: new Date().toISOString(), level, message, ...redact(fields) }));
}

export const logger = {
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields)
};
