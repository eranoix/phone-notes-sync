export interface Config {
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    mailbox: string;
    idleRestartMs: number;
  };
  databaseUrl: string;
  web: { host: string; port: number };
  sync: {
    concurrency: number;
    resyncIntervalMs: number;
    maxAttempts: number;
  };
  reconnect: { baseMs: number; maxMs: number };
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(env: Env = process.env): Config {
  const secure = bool(env, 'IMAP_SECURE', true);
  return {
    imap: {
      host: required(env, 'IMAP_HOST'),
      port: int(env, 'IMAP_PORT', secure ? 993 : 143),
      secure,
      user: required(env, 'IMAP_USER'),
      password: required(env, 'IMAP_PASSWORD'),
      mailbox: env.NOTES_MAILBOX || 'Notes',
      idleRestartMs: int(env, 'IDLE_RESTART_MS', 25 * 60_000),
    },
    databaseUrl: required(env, 'DATABASE_URL'),
    web: {
      host: env.WEB_HOST || '0.0.0.0',
      port: int(env, 'WEB_PORT', 8080),
    },
    sync: {
      concurrency: Math.max(1, int(env, 'SYNC_CONCURRENCY', 4)),
      resyncIntervalMs: int(env, 'RESYNC_INTERVAL_MS', 10 * 60_000),
      maxAttempts: Math.max(1, int(env, 'SYNC_MAX_ATTEMPTS', 4)),
    },
    reconnect: {
      baseMs: int(env, 'RECONNECT_BASE_MS', 1_000),
      maxMs: int(env, 'RECONNECT_MAX_MS', 60_000),
    },
  };
}
