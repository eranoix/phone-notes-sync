type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

function format(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === 'string') return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'bigint') return value.toString();
  return JSON.stringify(value);
}

function write(level: Level, scope: string, msg: string, fields?: Fields): void {
  if (order[level] < threshold) return;
  const parts = [new Date().toISOString(), level.padEnd(5), `[${scope}]`, msg];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) parts.push(`${k}=${format(v)}`);
    }
  }
  const line = parts.join(' ');
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, f) => write('debug', scope, m, f),
    info: (m, f) => write('info', scope, m, f),
    warn: (m, f) => write('warn', scope, m, f),
    error: (m, f) => write('error', scope, m, f),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
