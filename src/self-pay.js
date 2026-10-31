export function selfPayRequest(text) {
  const match = text.replace(/^medbase\s+/i, '').trim().match(/^(?:自費(?:項目|品項|查詢)?|查自費)(?:[\s:：]+(.+))?$/u);
  return match ? { query: match[1]?.trim() || '', offset: 0 } : null;
}

export function selfPayPage(data) {
  if (!data?.startsWith('mbitems:')) return null;
  try {
    const request = JSON.parse(data.slice(8));
    if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 100 ||
        !Number.isInteger(request.offset) || request.offset < 0 || request.offset > 10000) return null;
    return { query: request.query.trim(), offset: request.offset };
  } catch { return null; }
}

const text = (value, size = 'sm', extra = {}) => ({ type: 'text', text: value, size, wrap: true, ...extra });
const button = (label, action) => ({ type: 'button', style: 'secondary', height: 'sm', action: { label, ...action } });

export function selfPayResults(result, request, baseUrl) {
  if (!Array.isArray(result.items) || !Number.isInteger(result.total) || result.total < 0) throw new Error('自費查詢資料格式錯誤');
  const items = result.items.slice(0, 5);
  const details = new URL('/items', baseUrl);
  details.searchParams.set('q', request.query);
  const footer = [button('在 MedBase 查看', { type: 'uri', uri: details.toString() })];
  const pageButton = (label, offset) => button(label, { type: 'postback', data: 'mbitems:' + JSON.stringify({ query: request.query, offset }) });
  if (request.offset > 0) footer.unshift(pageButton('上一頁', Math.max(0, request.offset - 5)));
  if (request.offset + items.length < result.total && items.length && request.offset + 5 <= 10000) footer.unshift(pageButton('下一頁', request.offset + 5));
  const summary = {
    type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      text('MedBase 自費查詢', 'lg', {weight: 'bold'}), text(`搜尋：${request.query}`),
      text(items.length ? `找到 ${result.total} 筆，顯示第 ${request.offset + 1}～${request.offset + items.length} 筆。` : (result.total ? '這一頁已沒有結果，請回上一頁或重新搜尋。' : '查無符合品項，請改用名稱、英文名、院內碼或科別搜尋。')),
      text('點選品項卡片的按鈕即可複製。價格與資料以 MedBase 最新登錄為準。', 'xs')
    ] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer }
  };
  const cards = items.map(item => {
    if (typeof item.hospital_code !== 'string' || !item.hospital_code.trim() || item.hospital_code.length > 100) throw new Error('自費院內碼格式錯誤');
    const name = item.name_zh || item.name_en || item.hospital_code;
    if (typeof name !== 'string' || name.length > 500) throw new Error('自費品名格式錯誤');
    const code = item.hospital_code;
    const price = typeof item.price === 'number' && Number.isFinite(item.price) && item.price >= 0
      ? `登錄價格：NT$ ${item.price.toLocaleString('zh-TW')}${item.unit ? `／${item.unit}` : ''}` : '價格未登錄';
    const departments = Array.isArray(item.depts) ? item.depts.join('、') : '';
    const copy = `${name}\n院內碼：${code}`;
    const url = new URL('/items', baseUrl);
    url.searchParams.set('q', code);
    return { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      text(name, 'lg', {weight: 'bold'}), text(`院內碼：${code}`),
      ...(departments ? [text(`科別：${departments}`)] : []), text(price)
    ] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      button('複製院內碼', {type: 'clipboard', clipboardText: code}),
      button('複製名稱＋院內碼', {type: 'clipboard', clipboardText: copy}),
      button('複製完整資訊', {type: 'clipboard', clipboardText: `${copy}\n${price}${departments ? `\n科別：${departments}` : ''}`.slice(0, 1000)}),
      button('MedBase 詳情', {type: 'uri', uri: url.toString()})
    ] } };
  });
  return { type: 'flex', altText: `自費查詢「${request.query}」：找到 ${result.total} 筆`,
    contents: cards.length ? { type: 'carousel', contents: [...cards, summary] } : summary };
}
