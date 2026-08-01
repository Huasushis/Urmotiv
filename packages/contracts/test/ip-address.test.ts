import { describe, expect, it } from "vitest";
import {
  isIpAddressAllowedByCidrs,
  isIpAddressInCidr,
  normalizeIpAddress,
  normalizeIpCidr,
} from "../src";

describe("IP 地址与 CIDR", () => {
  it("规范化 IPv4、IPv6 和网络地址", () => {
    expect(normalizeIpAddress("192.0.2.17")).toBe("192.0.2.17");
    expect(normalizeIpAddress("2001:0DB8:0:0:0:0:0:17")).toBe("2001:db8::17");
    expect(normalizeIpAddress("::ffff:192.0.2.17")).toBe("192.0.2.17");
    expect(normalizeIpCidr("192.0.2.129/24")).toBe("192.0.2.0/24");
    expect(normalizeIpCidr("2001:0DB8:1::abcd/64")).toBe("2001:db8:1::/64");
    expect(normalizeIpCidr("::ffff:192.0.2.129/120")).toBe("192.0.2.0/24");
  });

  it("拒绝主机名、缺少前缀、前导零和畸形地址", () => {
    for (const value of [
      "proxy.example",
      "192.0.2.1",
      "192.0.2.01/32",
      "192.0.2.1/033",
      "2001:db8:::1/128",
      "2001:db8::1%eth0/128",
      "::ffff:192.0.2.1/95",
    ]) {
      expect(normalizeIpCidr(value)).toBeUndefined();
    }
  });

  it("按网络位匹配 IPv4 和 IPv6 的边界", () => {
    expect(isIpAddressInCidr("192.0.2.0", "192.0.2.0/24")).toBe(true);
    expect(isIpAddressInCidr("192.0.2.255", "192.0.2.0/24")).toBe(true);
    expect(isIpAddressInCidr("192.0.3.0", "192.0.2.0/24")).toBe(false);
    expect(isIpAddressInCidr("2001:db8:1::ffff", "2001:db8:1::/64")).toBe(true);
    expect(isIpAddressInCidr("2001:db8:2::1", "2001:db8:1::/64")).toBe(false);
  });

  it("把 IPv4-mapped IPv6 与对应 IPv4 来源视为同一地址", () => {
    expect(isIpAddressInCidr("::ffff:192.0.2.42", "192.0.2.0/24")).toBe(true);
    expect(isIpAddressInCidr("192.0.2.42", "::ffff:192.0.2.0/120")).toBe(true);
    expect(isIpAddressInCidr("::ffff:c000:22a", "::ffff:c000:200/120")).toBe(true);
    expect(isIpAddressInCidr("::ffff:192.0.3.42", "192.0.2.0/24")).toBe(false);
    expect(isIpAddressInCidr("2001:db8::1", "192.0.2.0/24")).toBe(false);
  });

  it("空范围不限制来源，非空范围对缺失或无效地址关闭访问", () => {
    expect(isIpAddressAllowedByCidrs(undefined, [])).toBe(true);
    expect(isIpAddressAllowedByCidrs(undefined, ["192.0.2.0/24"])).toBe(false);
    expect(isIpAddressAllowedByCidrs("invalid", ["192.0.2.0/24"])).toBe(false);
    expect(isIpAddressAllowedByCidrs("192.0.2.9", ["198.51.100.0/24", "192.0.2.0/24"])).toBe(true);
  });
});
