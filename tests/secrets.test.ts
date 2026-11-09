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
});
