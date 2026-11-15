/** Accept one complete JSON array, including arrays in a model's prose or code fence. */
export function parseModelArray(text: string): unknown[] {
  const whole = tryArray(text.trim());
  if (whole) return whole;

  const arrays: unknown[][] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (start < 0) {
      if (char === "[") {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === "[") {
      depth++;
    } else if (char === "]" && --depth === 0) {
      const value = tryArray(text.slice(start, i + 1));
      if (value) arrays.push(value);
      start = -1;
    }
  }
  if (start === -1 && arrays.length === 1) return arrays[0]!;
  throw new Error("模型响应缺少唯一、完整的 JSON 数组");
}

function tryArray(text: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
