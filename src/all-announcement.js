/** Read LINE's real all-mention metadata, never infer intent from quoted @all text. */
export function allAnnouncement(message) {
  if (message?.type !== 'text' || typeof message.text !== 'string') return null;
  const mentions = message.mention?.mentionees;
  if (!Array.isArray(mentions)) return null;
  const spans = mentions.filter(item => item?.type === 'all' && Number.isInteger(item.index) && Number.isInteger(item.length)
    && item.index >= 0 && item.length > 0 && item.index + item.length <= message.text.length);
  if (!spans.length) return null;
  let content = message.text;
  for (const span of spans.sort((a, b) => b.index - a.index)) {
    content = content.slice(0, span.index) + content.slice(span.index + span.length);
  }
  content = content.trim();
  if (!content) return null;
  const firstLine = content.split(/\r?\n/u).find(line => line.trim())?.trim() || '群組公告／提醒';
  return { title: Array.from(firstLine).slice(0, 40).join(''), content };
}
