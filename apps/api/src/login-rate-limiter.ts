/**
 * 只按来源地址（解析后的 remote/forwarded IP）限制登录尝试的服务器端限流器。
 * 永不按邮箱、账号或用户身份键控；响应由调用方统一返回同样的通用错误。
 * 时钟与存储全部注入，测试可完全确定性地推进窗口。
 */

export interface LoginRateAttemptWindow {
  readonly failed: number;
  readonly windowStartedAt: number;
}

export interface LoginRateLimiterStorage {
  get(ip: string): LoginRateAttemptWindow | undefined;
  set(ip: string, window: LoginRateAttemptWindow): void;
  delete(ip: string): void;
}

export interface LoginRateLimiterOptions {
  readonly maxFailedAttempts: number;
  readonly windowMs: number;
  readonly storage: LoginRateLimiterStorage;
  readonly now: () => number;
}

export class InMemoryLoginRateLimiterStorage implements LoginRateLimiterStorage {
  readonly #entries = new Map<string, LoginRateAttemptWindow>();

  public get(ip: string): LoginRateAttemptWindow | undefined {
    return this.#entries.get(ip);
  }

  public set(ip: string, window: LoginRateAttemptWindow): void {
    this.#entries.set(ip, window);
  }

  public delete(ip: string): void {
    this.#entries.delete(ip);
  }
}

export class LoginRateLimiter {
  readonly #maxFailedAttempts: number;
  readonly #windowMs: number;
  readonly #storage: LoginRateLimiterStorage;
  readonly #now: () => number;

  public constructor(options: LoginRateLimiterOptions) {
    this.#maxFailedAttempts = zPositiveInt(options.maxFailedAttempts, "maxFailedAttempts");
    this.#windowMs = zPositiveInt(options.windowMs, "windowMs");
    this.#storage = options.storage;
    this.#now = options.now;
  }

  /**
   * 该来源是否已在一段时间内失败过 maxFailedAttempts 次。来源地址无法解析时
   * 不做限制（放行），避免代理配置差异误锁合法用户。
   */
  public isBlocked(ip: string | undefined): boolean {
    if (ip === undefined) {
      return false;
    }
    const window = this.#storage.get(ip);
    if (window === undefined) {
      return false;
    }
    if (this.#now() >= window.windowStartedAt + this.#windowMs) {
      this.#storage.delete(ip);
      return false;
    }
    return window.failed >= this.#maxFailedAttempts;
  }

  /** 记录一次失败的登录尝试（重复尝试不会提前刷新窗口起点）。 */
  public recordFailure(ip: string | undefined): void {
    if (ip === undefined) {
      return;
    }
    const now = this.#now();
    const existing = this.#storage.get(ip);
    const window =
      existing !== undefined && now < existing.windowStartedAt + this.#windowMs
        ? existing
        : { failed: 0, windowStartedAt: now as number };
    this.#storage.set(ip, {
      failed: window.failed + 1,
      windowStartedAt: window.windowStartedAt
    });
  }

  /** 一次成功的登录清除该来源的全部失败记录。 */
  public recordSuccess(ip: string | undefined): void {
    if (ip !== undefined) {
      this.#storage.delete(ip);
    }
  }
}

function zPositiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数。`);
  }
  return value;
}
