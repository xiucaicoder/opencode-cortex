export interface BlockedField {
  field: "title" | "content" | "related_files" | "source_ref";
  rule: string;
}

type Rule = { name: string; pattern: RegExp };

const BUILT_IN: Rule[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "aws-access-key", pattern: /(?<![\w])(?:AKIA|ASIA)[A-Z0-9]{16}(?![\w])/g },
  { name: "github-token", pattern: /(?<![\w-])(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{40,})(?![\w-])/g },
  { name: "api-key", pattern: /(?<![\w-])(?:sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35})(?![\w-])/g },
  { name: "slack-token", pattern: /(?<![\w-])xox[baprs]-[0-9]{6,}-[A-Za-z0-9-]{10,}(?![\w-])/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  {
    name: "credential-assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/gi,
  },
  { name: "connection-string", pattern: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/gi },
  {
    name: "internal-ip",
    pattern:
      /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?![\d.])/g,
  },
  {
    name: "cn-id-card",
    pattern: /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
  },
];

function compileExtra(patterns: string[]): Rule[] {
  return patterns.map((source, index) => {
    try {
      return { name: `blockedPatterns[${index}]`, pattern: new RegExp(source, "i") };
    } catch (error) {
      throw new Error(
        `配置项 blockedPatterns[${index}] 不是合法正则：${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}

function matches(text: string, rules: Rule[]): string | null {
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) return rule.name;
  }
  return null;
}

/** Return the first blocked field/rule, or null when all fields are safe. */
export function findBlockedField(
  fields: {
    title: string;
    content: string;
    related_files: string[];
    source_ref?: string;
  },
  extraPatterns: string[] = []
): BlockedField | null {
  const rules = [...BUILT_IN, ...compileExtra(extraPatterns)];
  const checks: Array<[BlockedField["field"], string]> = [
    ["title", fields.title],
    ["content", fields.content],
    ["related_files", fields.related_files.join("\n")],
    ...(fields.source_ref ? ([["source_ref", fields.source_ref]] as Array<[BlockedField["field"], string]>) : []),
  ];
  for (const [field, value] of checks) {
    const rule = matches(value, rules);
    if (rule) return { field, rule };
  }
  return null;
}
