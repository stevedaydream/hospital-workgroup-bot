/** Keep the integration contract small even if MedBase later adds more fields. */
export function doctorRoster(items) {
  if (!Array.isArray(items)) throw new Error('MedBase 主治醫師名單格式錯誤');
  const seen = new Set();
  return items.flatMap(p => {
    if (!p || typeof p !== 'object') return [];
    const name = String(p.name || '').replace(/\s+/g, '').slice(0, 80);
    const department = String(p.department || '').trim().slice(0, 80);
    const title = String(p.title || '').trim().slice(0, 80);
    if (!name || !(/主治/.test(title) || /^VS$/i.test(title))) return [];
    const key = JSON.stringify([name, department]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name, department, title }];
  });
}
