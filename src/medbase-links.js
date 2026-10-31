const DESTINATIONS = [
  ['自費品項', '/items'],
  ['通訊錄', '/contacts'],
  ['處方與套組', '/sets'],
  ['班表', '/schedule'],
  ['規則備忘錄', '/memos']
];

/** Navigation only. MedBase continues to enforce its own login and permissions. */
export function medbaseLinkCommand(text, baseUrl) {
  const command = text.replace(/^medbase\s+/i, '').trim();
  const items = command.match(/^(?:自費(?:項目|品項|查詢)?|查自費)(?:[\s:：]+(.+))?$/u);
  const menu = /^medbase(?:\s*(?:查詢|選單))?$/i.test(text.trim());
  if (!items && !menu) return null;
  const query = items?.[1]?.trim() || '';
  const urlFor = path => new URL(path, baseUrl).toString();
  const url = new URL('/items', baseUrl);
  if (query) url.searchParams.set('q', query);
  if (items && url.toString().length > 900) return { type: 'text', text: '搜尋關鍵字過長，請縮短後再試，例如「自費 人工關節」。' };
  const title = items ? 'MedBase 自費品項' : 'MedBase 功能查詢';
  const description = items
    ? (query ? `搜尋：${query.slice(0, 200)}\n點下方按鈕查看 MedBase 的品項資料。` : '點下方按鈕查詢自費品項、院內碼與價格。')
    : '選擇要開啟的功能。自費搜尋可輸入「自費 關鍵字」。';
  const buttons = items
    ? [{ label: query ? '開啟自費搜尋結果' : '開啟自費品項', uri: url.toString() }]
    : DESTINATIONS.map(([label, path]) => ({ label, uri: urlFor(path) }));
  return {
    type: 'flex', altText: `${title}${query ? `：${query.slice(0, 100)}` : ''}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true },
        { type: 'text', text: description, size: 'sm', wrap: true },
        { type: 'text', text: '如尚未登入，請先登入 MedBase；可查看的內容依帳號權限顯示。', size: 'xs', wrap: true }
      ] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons.map(({label, uri}) => ({
        type: 'button', style: 'primary', color: '#0f766e', height: 'sm', action: { type: 'uri', label, uri }
      })) }
    }
  };
}
