import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

function sanitizeCsvCell(val: unknown): string {
  let str = String(val ?? '');
  // Guard against spreadsheet formula injection (=, +, -, @)
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportRowsToExcel(
  rows: Record<string, string | number | boolean | null | undefined>[],
  _sheetName: string,
  fileName: string
): void {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.map(sanitizeCsvCell).join(','),
    ...rows.map((row) => headers.map((h) => sanitizeCsvCell(row[h])).join(',')),
  ];
  // UTF-8 BOM guarantees Microsoft Excel renders Arabic & French characters cleanly
  const csvContent = `\uFEFF${csvLines.join('\r\n')}`;
  const outName = fileName.replace(/\.xlsx$/i, '.csv');
  downloadTextFile(
    csvContent,
    outName.endsWith('.csv') ? outName : `${outName}.csv`,
    'text/csv;charset=utf-8;'
  );
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

export async function parseExcelFileToJson(
  file: File
): Promise<Record<string, unknown>[]> {
  const text = (await file.text()).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Auto-detect comma vs semicolon vs tab delimiter (European/Moroccan Excel uses ;)
  const headerLine = lines[0];
  const delimiter =
    headerLine.includes(';') && !headerLine.includes(',')
      ? ';'
      : headerLine.includes('\t')
        ? '\t'
        : ',';

  const headers = parseCsvLine(headerLine, delimiter);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line, delimiter);
    const obj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] ?? '';
    });
    return obj;
  });
}

export function exportTableToPdf(
  title: string,
  subtitle: string,
  columns: string[],
  rows: (string | number)[][],
  fileName: string
): void {
  const doc = new jsPDF({ orientation: columns.length > 6 ? 'landscape' : 'portrait' });
  doc.setFontSize(14);
  doc.text(title, 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(subtitle, 14, 23);

  autoTable(doc, {
    startY: 28,
    head: [columns],
    body: rows.map((r) => r.map((c) => String(c ?? ''))),
    styles: { fontSize: 8, cellPadding: 2.5 },
    headStyles: { fillColor: [15, 118, 110], textColor: 255 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  });

  doc.save(fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`);
}

export function downloadTextFile(content: string, fileName: string, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
