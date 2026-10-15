/**
 * Levelled logging to stdout/stderr, which is where systemd, `journalctl` and
 * `docker logs` expect it. Errors always carry their stack.
 */

type Level = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  return ORDER[raw as Level] ?? ORDER.info;
}

function format(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function emit(level: Level, message: string, detail?: unknown): void {
  if (ORDER[level] > threshold()) return;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`);
  if (detail !== undefined) {
    stream.write(`${format(detail)}\n`);
  }
}

export const log = {
  error: (message: string, detail?: unknown): void => emit('error', message, detail),
  warn: (message: string, detail?: unknown): void => emit('warn', message, detail),
  info: (message: string, detail?: unknown): void => emit('info', message, detail),
  debug: (message: string, detail?: unknown): void => emit('debug', message, detail),
};
