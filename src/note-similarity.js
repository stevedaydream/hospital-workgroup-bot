// Candidate detection only: changed doses or restrictions must be reviewed,
// never silently treated as identical medical instructions.
export const normalizeNotice = value => value.normalize('NFKC').replace(/\s+/gu, '');

export function similarNoticeContent(a, b) {
  const normalize = text => normalizeNotice(text).toLowerCase().replace(/[\p{P}\p{S}]/gu, '');
  a = normalize(a);
  b = normalize(b);
  if (Math.min(a.length, b.length) < 30) return false;
  const grams = text => new Set(Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2)));
  const left = grams(a), right = grams(b);
  const common = [...left].filter(gram => right.has(gram)).length;
  return common / left.size >= 0.65 && common / right.size >= 0.65;
}
