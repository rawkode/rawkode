const WORDS_PER_MINUTE = 220;

export function calculateWordCount(body = ''): number {
  return body.trim().split(/\s+/).filter(Boolean).length;
}

export function calculateReadingMinutes(body = ''): number {
  return Math.max(1, Math.round(calculateWordCount(body) / WORDS_PER_MINUTE));
}
