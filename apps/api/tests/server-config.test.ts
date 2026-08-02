import { describe, expect, it } from "vitest";
import {
  readServerAuthenticationOptions,
  readServerDatabaseOptions,
  readServerOptions,
  readTrustedProxyCidrs
} from "../src/server-config";

describe("服务启动配置", () => {
  it("只在显式设置时开启演示登录并拆分网页来源", () => {
    expect(
      readServerOptions({
        URMOTIV_DEMO_AUTH: "true",
        URMOTIV_WEB_ORIGIN: "http://localhost:5173, http://127.0.0.1:5173"
      })
    ).toEqual({
      secureCookies: false,
      demoAuthEnabled: true,
      emailLoginEnabled: true,
      emailRegistrationEnabled: false,
      allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"]
    });
  });

  it("拒绝在生产环境开启演示登录", () => {
    expect(() =>
      readServerOptions({ NODE_ENV: "production", URMOTIV_DEMO_AUTH: "true" })
    ).toThrow("生产环境不能启用演示登录");
  });

  it("开发环境未配置来源时保留应用默认值", () => {
    expect(readServerOptions({})).toEqual({
      secureCookies: false,
      demoAuthEnabled: false,
      emailLoginEnabled: true,
      emailRegistrationEnabled: false
    });
  });

  it("生产环境必须明确配置网页来源", () => {
    expect(() => readServerOptions({ NODE_ENV: "production" })).toThrow(
      "生产环境必须配置 URMOTIV_WEB_ORIGIN"
    );
  });

  it("未配置可信代理时不启用代理信任", () => {
    expect(readTrustedProxyCidrs(undefined)).toEqual([]);
    expect(readTrustedProxyCidrs("   ")).toEqual([]);
    expect(readServerOptions({})).not.toHaveProperty("trustedProxyCidrs");
  });

  it("规范化显式配置的 IPv4 与 IPv6 可信代理范围", () => {
    expect(readTrustedProxyCidrs("192.0.2.19/28, 2001:0DB8:1::abcd/64")).toEqual([
      "192.0.2.16/28",
      "2001:db8:1::/64"
    ]);
    expect(readTrustedProxyCidrs("::ffff:192.0.2.19/120")).toEqual(["192.0.2.0/24"]);
    expect(readServerOptions({
      URMOTIV_TRUSTED_PROXY_CIDRS: "192.0.2.19/28"
    })).toMatchObject({ trustedProxyCidrs: ["192.0.2.16/28"] });
  });

  it("对所有危险或畸形可信代理配置返回同一条安全错误", () => {
    const invalidValues = [
      "true",
      "1",
      "proxy.invalid",
      "192.0.2.1",
      "0.0.0.0/0",
      "192.0.2.1/0",
      "::/0",
      "2001:db8::1/0",
      "::ffff:0.0.0.0/96",
      "192.0.2.1/24,192.0.2.200/24",
      "192.0.2.1/32,::ffff:192.0.2.1/128",
      "192.0.2.1/32,,198.51.100.1/32",
      Array.from({ length: 33 }, (_value, index) => `192.0.2.${index}/32`).join(",")
    ];
    const messages = invalidValues.map((value) => {
      try {
        readTrustedProxyCidrs(value);
        return "没有拒绝";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(new Set(messages)).toEqual(new Set([
      "URMOTIV_TRUSTED_PROXY_CIDRS 必须是最多 32 项、逗号分隔且不含全网范围的 IPv4 或 IPv6 CIDR。"
    ]));
    expect(messages.join("\n")).not.toContain("proxy.invalid");
  });
});

describe("认证启动配置", () => {
  it("拒绝仅开启注册而关闭邮箱登录的配置", () => {
    expect(() =>
      readServerAuthenticationOptions({
        URMOTIV_EMAIL_LOGIN_ENABLED: "false",
        URMOTIV_EMAIL_REGISTRATION_ENABLED: "true"
      })
    ).toThrow("开启邮箱注册前必须开启邮箱登录");
  });

  const validCasEnvironment = {
    URMOTIV_CAS_ENABLED: "true",
    URMOTIV_CAS_LOGIN_URL: "https://id.example/cas/login",
    URMOTIV_CAS_VALIDATE_URL: "https://id.example/cas/serviceValidate",
    URMOTIV_CAS_CALLBACK_URL: "https://problems.example/api/v1/auth/cas/callback",
    URMOTIV_WEB_ORIGIN: "https://problems.example",
    URMOTIV_CAS_SUBJECT_ATTRIBUTE: "accountId",
    URMOTIV_CAS_STATE_SECRET: Buffer.alloc(32, 7).toString("base64url"),
    URMOTIV_PLUGIN_SECRET_KEY: Buffer.alloc(32, 8).toString("base64url")
  } as const;

  it("CAS 关闭时不要求也不解析 CAS 配置", () => {
    expect(readServerAuthenticationOptions({}).cas).toBeUndefined();
    expect(
      readServerAuthenticationOptions({
        URMOTIV_CAS_ENABLED: "false",
        URMOTIV_CAS_LOGIN_URL: "not-a-url",
        URMOTIV_CAS_STATE_SECRET: "not-a-secret"
      }).cas
    ).toBeUndefined();
  });

  it("只接受明确的 CAS 开关值", () => {
    for (const value of ["TRUE", "1", "yes", " false "]) {
      expectCasConfigurationError({ URMOTIV_CAS_ENABLED: value }, value);
    }
  });

  it("要求 CAS 明确配置稳定身份字段和规范的 32 字节状态密钥", () => {
    expect(
      readServerAuthenticationOptions(validCasEnvironment).cas?.configuration.subjectAttribute
    ).toBe("accountId");

    for (const key of [
      "URMOTIV_CAS_LOGIN_URL",
      "URMOTIV_CAS_VALIDATE_URL",
      "URMOTIV_CAS_CALLBACK_URL",
      "URMOTIV_CAS_SUBJECT_ATTRIBUTE",
      "URMOTIV_CAS_STATE_SECRET"
    ] as const) {
      const incomplete = { ...validCasEnvironment } as Record<string, string | undefined>;
      delete incomplete[key];
      expectCasConfigurationError(incomplete, key);
    }
  });

  it("对畸形或非规范状态密钥只返回固定安全错误", () => {
    const invalidSecrets = [
      "secret-sentinel",
      Buffer.alloc(31, 3).toString("base64url"),
      Buffer.alloc(33, 3).toString("base64url"),
      `${Buffer.alloc(32, 3).toString("base64url")}=`,
      ` ${Buffer.alloc(32, 3).toString("base64url")}`
    ];
    for (const secret of invalidSecrets) {
      expectCasConfigurationError(
        { ...validCasEnvironment, URMOTIV_CAS_STATE_SECRET: secret },
        secret
      );
    }
  });

  it("拒绝把 CAS 状态密钥与插件加密密钥复用", () => {
    expectCasConfigurationError(
      {
        ...validCasEnvironment,
        URMOTIV_CAS_STATE_SECRET: validCasEnvironment.URMOTIV_PLUGIN_SECRET_KEY
      },
      validCasEnvironment.URMOTIV_PLUGIN_SECRET_KEY
    );
  });

  it("生产环境要求当前 CAS 契约的三个地址全部使用 HTTPS", () => {
    for (const key of [
      "URMOTIV_CAS_LOGIN_URL",
      "URMOTIV_CAS_VALIDATE_URL",
      "URMOTIV_CAS_CALLBACK_URL"
    ] as const) {
      const unsafeUrl = `http://unsafe-${key.toLowerCase()}.example.test/path`;
      expectCasConfigurationError(
        { ...validCasEnvironment, NODE_ENV: "production", [key]: unsafeUrl },
        unsafeUrl
      );
    }
  });

  it("把 CAS 回调精确绑定到本站公开来源和固定路径", () => {
    const invalidCallbacks = [
      "https://other.example/api/v1/auth/cas/callback",
      "https://problems.example/api/v1/auth/cas/callback/",
      "https://problems.example/api/v1/auth/cas/other",
      "https://problems.example/api/v1/auth/cas/callback?fixed=value",
      "https://problems.example/api/v1/auth/cas/callback#fragment"
    ];
    for (const callbackUrl of invalidCallbacks) {
      expectCasConfigurationError(
        {
          ...validCasEnvironment,
          NODE_ENV: "production",
          URMOTIV_CAS_CALLBACK_URL: callbackUrl
        },
        callbackUrl
      );
    }
    expect(
      readServerAuthenticationOptions({
        ...validCasEnvironment,
        NODE_ENV: "production",
        URMOTIV_WEB_ORIGIN: "https://problems.example/"
      }).cas
    ).toBeDefined();
  });

  it("正式环境启用 CAS 时要求单一 HTTPS 本站来源", () => {
    for (const webOrigin of [
      "http://problems.example",
      "https://problems.example/path",
      "https://problems.example?query=value",
      "https://problems.example,https://other.example",
      " https://problems.example"
    ]) {
      expectCasConfigurationError(
        { ...validCasEnvironment, NODE_ENV: "production", URMOTIV_WEB_ORIGIN: webOrigin },
        webOrigin
      );
    }
  });

  it("不透传 URL 和字段校验器的原始错误或配置值", () => {
    const invalidConfigurations = [
      {
        ...validCasEnvironment,
        URMOTIV_CAS_LOGIN_URL: "not-a-url-sentinel"
      },
      {
        ...validCasEnvironment,
        URMOTIV_CAS_VALIDATE_URL: "https://account:password-sentinel@id.example/validate"
      },
      {
        ...validCasEnvironment,
        URMOTIV_CAS_SUBJECT_ATTRIBUTE: "invalid attribute sentinel"
      }
    ];
    for (const configuration of invalidConfigurations) {
      const sentinel = Object.values(configuration).find((value) => value.includes("sentinel"));
      expectCasConfigurationError(configuration, sentinel ?? "sentinel");
    }
  });

  it("非生产测试环境可以显式连接本机 HTTP CAS 替身", () => {
    expect(
      readServerAuthenticationOptions({
        ...validCasEnvironment,
        NODE_ENV: "test",
        URMOTIV_CAS_LOGIN_URL: "http://127.0.0.1:4100/login",
        URMOTIV_CAS_VALIDATE_URL: "http://127.0.0.1:4100/serviceValidate",
        URMOTIV_CAS_CALLBACK_URL: "http://127.0.0.1:3000/api/v1/auth/cas/callback"
      }).cas
    ).toBeDefined();
  });

  it("only allows the in-memory delivery sink in automated tests", () => {
    expect(() => readServerAuthenticationOptions({ URMOTIV_EMAIL_REGISTRATION_ENABLED: "true" })).toThrow(
      "邮箱注册只能在测试环境使用内存投递"
    );
    expect(
      readServerAuthenticationOptions({
        NODE_ENV: "test",
        URMOTIV_EMAIL_REGISTRATION_ENABLED: "true",
        URMOTIV_EMAIL_DELIVERY_MODE: "test",
        URMOTIV_EMAIL_VERIFICATION_WEB_URL: "http://localhost:5173"
      }).emailVerification
    ).toEqual({ mode: "test", webUrl: "http://localhost:5173" });
  });
});

function expectCasConfigurationError(
  environment: Parameters<typeof readServerAuthenticationOptions>[0],
  forbiddenOutput: string
): void {
  let message = "没有拒绝";
  try {
    readServerAuthenticationOptions(environment);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe("URMOTIV_CAS_CONFIGURATION_INVALID");
  expect(message).not.toContain(forbiddenOutput);
}

describe("数据库启动配置", () => {
  it("开发环境默认使用有文件目录的 PGlite", () => {
    expect(readServerDatabaseOptions({})).toEqual({
      kind: "pglite",
      dataDirectory: ".data/database",
      migrate: true,
      seedDemoData: false
    });
  });

  it("配置连接地址后使用 PostgreSQL，且不自动执行迁移", () => {
    expect(
      readServerDatabaseOptions({ DATABASE_URL: "postgres://database.example/urmotiv" })
    ).toEqual({
      kind: "postgres",
      connectionString: "postgres://database.example/urmotiv",
      migrate: false,
      seedDemoData: false
    });
  });

  it("拒绝生产 API 进程内迁移，避免绕过首位管理员初始化", () => {
    expect(() => readServerDatabaseOptions({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://database.example/urmotiv",
      URMOTIV_DATABASE_MIGRATE: "true"
    })).toThrow("URMOTIV_PRODUCTION_API_MIGRATION_FORBIDDEN");
  });

  it("生产环境不允许退回本地文件数据库", () => {
    expect(() => readServerDatabaseOptions({ NODE_ENV: "production" })).toThrow(
      "生产环境必须配置 DATABASE_URL"
    );
  });

  it("没有开启演示登录时拒绝初始化演示数据", () => {
    expect(() => readServerDatabaseOptions({ URMOTIV_DEMO_SEED: "true" })).toThrow(
      "必须显式开启 URMOTIV_DEMO_AUTH"
    );
  });
});
