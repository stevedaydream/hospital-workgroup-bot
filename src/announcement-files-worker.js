import { parentPort, workerData } from 'node:worker_threads';
import yauzl from 'yauzl';

// DOCX/XLSX are ZIP containers. Bound expanded data before either parser inflates entries.
async function checkArchive(buffer) {
  await new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    let bytes = 0, entries = 0;
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      bytes += entry.uncompressedSize;
      entries++;
      if (bytes > 25 * 1024 * 1024 || entries > 2000 || entry.generalPurposeBitFlag & 1) {
        zip.close(); reject(new Error('檔案解壓後過大、項目過多或已加密，請拆分／解密後重傳')); return;
      }
      zip.readEntry();
    });
    zip.readEntry();
  }));
}

try {
  const buffer = Buffer.from(workerData.buffer);
  if (['docx', 'xlsx'].includes(workerData.extension)) await checkArchive(buffer);
  let text = '';
  switch (workerData.extension) {
    case 'pdf': {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false }).promise;
      try {
        if (doc.numPages > 100) throw new Error('PDF 超過 100 頁，請拆分檔案');
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const { items } = await page.getTextContent();
          const pageText = items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('');
          if (!pageText.trim()) throw new Error(`PDF 第 ${i} 頁沒有可擷取文字，請改傳該頁截圖使用圖片辨識`);
          text += `\n第 ${i} 頁\n${pageText}`;
          if (text.length > 100000) throw new Error('檔案文字過長，請拆分檔案');
        }
      } finally { await doc.destroy(); }
      break;
    }
    case 'docx': {
      const mammoth = await import('mammoth');
      text = (await mammoth.default.extractRawText({ buffer })).value;
      break;
    }
    case 'xlsx': {
      const { default: ExcelJS } = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      for (const sheet of workbook.worksheets) {
        text += `\n工作表：${sheet.name}\n`;
        sheet.eachRow(row => {
          const cells = [];
          row.eachCell({ includeEmpty: true }, cell => cells.push(cell.value instanceof Date
            ? (cell.value.getUTCFullYear() <= 1900 ? cell.value.toISOString().slice(11, 19) : cell.value.toISOString()) : cell.text));
          text += cells.join('\t') + '\n';
          if (text.length > 100000) throw new Error('檔案文字過長，請拆分檔案');
        });
      }
      break;
    }
    default: throw new Error('不支援的檔案類型');
  }
  if (!text.trim()) throw new Error('沒有可讀取的文字；掃描檔或內嵌圖片請改傳截圖使用圖片辨識');
  if (text.length > 100000) throw new Error('檔案文字過長，請拆分檔案');
  parentPort.postMessage({ text });
} catch (error) { parentPort.postMessage({ error: error.message }); }
