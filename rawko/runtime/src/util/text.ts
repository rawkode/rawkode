export function extractText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractText(item)).filter(Boolean).join("\n").trim();
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = [
      "text",
      "output_text",
      "content",
      "message",
      "output",
      "data",
      "completion",
      "response",
    ];

    for (const key of preferred) {
      if (key in record) {
        const text = extractText(record[key]);
        if (text) {
          return text;
        }
      }
    }

    return Object.values(record).map((item) => extractText(item)).filter(Boolean).join("\n").trim();
  }

  return "";
}
