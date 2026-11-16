// '一般外科GS' -> '一般外科'; a department with no Chinese part is kept as is.
const shortDepartment = dept => dept.replace(/[\sA-Za-z/()（）]+$/, '').trim() || dept;

/**
 * The department label for a doctor-group mapping: the doctor's department in
 * the MedBase roster, or for a department code such as URO the roster
 * department carrying that code. Null when the roster does not say.
 */
export function mappingDepartment(map, roster) {
  if (!Array.isArray(roster) || !map?.match_key) return null;
  const key = map.match_key.replace(/\s+/g, '');
  const depts = map.type === 'FLEXIBLE'
    ? roster.map(d => d.department).filter(dept => dept && dept.toUpperCase().endsWith(key.toUpperCase()))
    : roster.filter(d => d.name === key).map(d => d.department).filter(Boolean);
  const labels = [...new Set(depts.map(shortDepartment))];
  return labels.length ? labels.join('／') : null;
}

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
