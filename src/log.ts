export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Structured JSON logger on stderr, so stdout stays free for the run summary. */
export function createLogger(silent = false): Logger {
  const emit = (level: string, message: string, fields?: LogFields): void => {
    if (silent) return;
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields })}\n`);
  };
  return {
    info: (m, f) => {
      emit('info', m, f);
    },
    warn: (m, f) => {
      emit('warn', m, f);
    },
    error: (m, f) => {
      emit('error', m, f);
    },
  };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
