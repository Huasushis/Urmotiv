import { describe, expect, it } from "vitest";
import {
  InMemoryLoginRateLimiterStorage,
  LoginRateLimiter
} from "../src/login-rate-limiter";

class FakeClock {
  public now = 1_000_000;
  public advance(milliseconds: number): void {
    this.now += milliseconds;
  }
  public at(): number {
    return this.now;
  }
}

interface Harness {
  readonly clock: FakeClock;
  readonly limiter: LoginRateLimiter;
}

function createLimiter(options: {
  maxFailedAttempts?: number;
  windowMs?: number;
} = {}): Harness {
  const clock = new FakeClock();
  const limiter = new LoginRateLimiter({
    maxFailedAttempts: options.maxFailedAttempts ?? 3,
    windowMs: options.windowMs ?? 60_000,
    storage: new InMemoryLoginRateLimiterStorage(),
    now: () => clock.at()
  });
  return { clock, limiter };
}

describe("登录限流器（只按来源地址键控）", () => {
  it("同一窗口内超过失败上限后按来源阻止，窗口过期后自动放行", () => {
    const { clock, limiter } = createLimiter({ maxFailedAttempts: 2, windowMs: 60_000 });
    expect(limiter.isBlocked("10.0.0.1")).toBe(false);
    limiter.recordFailure("10.0.0.1");
    limiter.recordFailure("10.0.0.1");
    expect(limiter.isBlocked("10.0.0.1")).toBe(true);
    // 第二个来源不受影响。
    expect(limiter.isBlocked("10.0.0.2")).toBe(false);
    clock.advance(60_001);
    expect(limiter.isBlocked("10.0.0.1")).toBe(false);
    // 过期后的新失败重新开窗。
    limiter.recordFailure("10.0.0.1");
    expect(limiter.isBlocked("10.0.0.1")).toBe(false);
  });

  it("成功登录清除该来源的全部失败记录", () => {
    const { limiter } = createLimiter({ maxFailedAttempts: 1 });
    limiter.recordFailure("10.0.0.1");
    expect(limiter.isBlocked("10.0.0.1")).toBe(true);
    limiter.recordSuccess("10.0.0.1");
    expect(limiter.isBlocked("10.0.0.1")).toBe(false);
    limiter.recordFailure("10.0.0.1");
    expect(limiter.isBlocked("10.0.0.1")).toBe(true);
  });

  it("来源地址无法解析时始终放行（fail-open）", () => {
    const { limiter } = createLimiter({ maxFailedAttempts: 1 });
    limiter.recordFailure(undefined);
    expect(limiter.isBlocked(undefined)).toBe(false);
    expect(limiter.isBlocked(undefined)).toBe(false);
  });

  it("参数必须是正整数，配置错误直接抛错", () => {
    expect(() => createLimiter({ maxFailedAttempts: 0 })).toThrow();
    expect(
      () =>
        new LoginRateLimiter({
          maxFailedAttempts: 2,
          windowMs: -1,
          storage: new InMemoryLoginRateLimiterStorage(),
          now: () => 0
        })
    ).toThrow();
  });
});
