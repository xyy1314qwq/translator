const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
export const PCM_BYTES_PER_SECOND = 16_000 * 2;

export class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.status = 429;
  }
}

function limit(env, name, fallback) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(`Invalid usage limit: ${name}`);
  }
  return value;
}

export function usageLimits(env) {
  return {
    concurrency: [limit(env, "MAX_CONCURRENT_PER_IP", 2), limit(env, "MAX_CONCURRENT_GLOBAL", 4)],
    sessionSeconds: limit(env, "MAX_SESSION_SECONDS", 10_800),
    audioSeconds: [limit(env, "DAILY_AUDIO_SECONDS_PER_IP", 21_600), limit(env, "DAILY_AUDIO_SECONDS_GLOBAL", 43_200)],
    translations: [limit(env, "DAILY_TRANSLATIONS_PER_IP", 3_000), limit(env, "DAILY_TRANSLATIONS_GLOBAL", 6_000)],
  };
}

// All callers use one Durable Object. Synchronous SQLite transactions make
// checking and charging an indivisible operation, independent of token nonce.
export class UsageBudget {
  constructor(storage, limits) {
    this.storage = storage;
    this.sql = storage.sql;
    this.limits = limits;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_events (
        kind TEXT NOT NULL, principal TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rate_kind_time ON rate_events(kind, at);
      CREATE INDEX IF NOT EXISTS rate_principal_time ON rate_events(kind, principal, at);
      CREATE TABLE IF NOT EXISTS daily_usage (
        day INTEGER NOT NULL, kind TEXT NOT NULL, principal TEXT NOT NULL,
        used INTEGER NOT NULL, PRIMARY KEY(day, kind, principal)
      );
    `);
    this.nextCleanup = 0;
  }

  charge(kind, principal, { minute, daily, amount = 1 }, now = Date.now()) {
    return this.storage.transactionSync(() => {
      const day = Math.floor(now / DAY_MS);
      if (now >= this.nextCleanup) {
        this.sql.exec("DELETE FROM rate_events WHERE at <= ?", now - MINUTE_MS);
        this.sql.exec("DELETE FROM daily_usage WHERE day < ?", day);
        this.nextCleanup = now + MINUTE_MS;
      }
      if (minute) {
        const local = this.sql.exec(
          "SELECT COUNT(*) AS n FROM rate_events WHERE kind = ? AND principal = ? AND at > ?",
          kind, principal, now - MINUTE_MS
        ).one().n;
        const global = this.sql.exec(
          "SELECT COUNT(*) AS n FROM rate_events WHERE kind = ? AND at > ?", kind, now - MINUTE_MS
        ).one().n;
        if (local >= minute[0] || global >= minute[1]) {
          throw new BudgetError("请求过于频繁，请稍后重试");
        }
      }
      const keys = [principal, "*"];
      const usage = daily ? keys.map(key => this.sql.exec(
        "SELECT used FROM daily_usage WHERE day = ? AND kind = ? AND principal = ?",
        day, kind, key
      ).toArray()[0]?.used || 0) : [];
      if (daily && usage.some((used, i) => used + amount > daily[i])) {
        throw new BudgetError("今日使用额度已达上限");
      }
      if (minute) this.sql.exec("INSERT INTO rate_events VALUES (?, ?, ?)", kind, principal, now);
      if (daily) keys.forEach((key, i) => this.sql.exec(
        "INSERT INTO daily_usage VALUES (?, ?, ?, ?) ON CONFLICT(day, kind, principal) DO UPDATE SET used = excluded.used",
        day, kind, key, usage[i] + amount
      ));
    });
  }

  token(principal) {
    // A normal six-hour class allowance needs roughly 432 renewals at 50s.
    this.charge("token", principal, { minute: [6, 60], daily: [1_000, 2_000] });
  }

  translation(principal) {
    this.charge("translation", principal, { minute: [60, 180], daily: this.limits.translations });
  }

  speechStart(principal) {
    this.charge("speech-start", principal, { minute: [4, 12], daily: [24, 48] });
  }

  audio(principal, bytes) {
    this.charge("audio", principal, {
      daily: this.limits.audioSeconds.map(seconds => seconds * PCM_BYTES_PER_SECOND),
      amount: bytes,
    });
  }
}
