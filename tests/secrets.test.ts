import { describe, expect, it } from "bun:test";
import { findBlockedField, redactSecrets } from "../src/secrets.js";

describe("secret handling", () => {
  it("redacts built-in and configured patterns", () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const result = redactSecrets(`key=${key} tenant=acme-prod`, ["acme-prod"]);
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain(key);
    expect(result.text).not.toContain("acme-prod");
    expect(result.hits).toBe(2);
    expect(result.rules).toContain("aws-access-key");
    expect(result.rules).toContain("blockedPatterns[0]");
  });

  it("keeps write interception and redaction on the same rule set", () => {
    const blocked = findBlockedField(
      {
        title: "配置",
        content: "password=supersecret123",
        related_files: [],
      },
      []
    );
    expect(blocked?.rule).toBe("credential-assignment");
    const result = redactSecrets("password=supersecret123");
    expect(result.text).toBe("[REDACTED]");
  });

  it("redacts phones, emails, private IPv6 addresses and spoken secrets", () => {
    const phone = "13800138000";
    const email = "ops@example.com";
    const ipv6 = "fd00::1";
    const spoken = "数据库密码是 Prod#2026x";
    const result = redactSecrets(
      `联系 ${phone} 或 ${email}，内网入口 ${ipv6}，${spoken}，公网 2001:db8::1 保留。`
    );
    expect(result.text).not.toContain(phone);
    expect(result.text).not.toContain(email);
    expect(result.text).not.toContain(ipv6);
    expect(result.text).not.toContain("Prod#2026x");
    expect(result.text).toContain("2001:db8::1");
    expect(result.text.match(/\[REDACTED\]/g)).toHaveLength(4);
    expect(result.rules).toContain("phone-number");
    expect(result.rules).toContain("email");
    expect(result.rules).toContain("ipv6-private");
    expect(result.rules).toContain("secret-phrase-zh");
  });

  it("keeps business wording about keys out of the spoken-secret rule", () => {
    expect(redactSecrets("幂等密钥是用渠道流水号，不是支付单号").hits).toBe(0);
  });
});
