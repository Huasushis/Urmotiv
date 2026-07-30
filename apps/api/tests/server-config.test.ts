import { describe, expect, it } from "vitest";
import {
  readServerAuthenticationOptions,
  readServerDatabaseOptions,
  readServerOptions
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

  it("要求 CAS 明确配置稳定身份字段和足够长的状态密钥", () => {
    expect(() => readServerAuthenticationOptions({ URMOTIV_CAS_ENABLED: "true" })).toThrow();
    expect(
      readServerAuthenticationOptions({
        URMOTIV_CAS_ENABLED: "true",
        URMOTIV_CAS_LOGIN_URL: "https://id.example/cas/login",
        URMOTIV_CAS_VALIDATE_URL: "https://id.example/cas/serviceValidate",
        URMOTIV_CAS_CALLBACK_URL: "https://problems.example/api/v1/auth/cas/callback",
        URMOTIV_CAS_SUBJECT_ATTRIBUTE: "accountId",
        URMOTIV_CAS_STATE_SECRET: Buffer.alloc(32, 7).toString("base64url")
      }).cas?.configuration.subjectAttribute
    ).toBe("accountId");
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
