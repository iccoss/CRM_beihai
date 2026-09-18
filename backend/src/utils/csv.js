function escapeCsvCell(value) {
  const normalized = value === undefined || value === null
    ? ''
    : String(value).replace(/\r?\n/g, ' ');
  return `"${normalized.replace(/"/g, '""')}"`;
}

function sendCsv(res, filename, headers, rows) {
  const lines = [headers.map(item => escapeCsvCell(item.label)).join(',')];
  rows.forEach(row => {
    lines.push(headers.map(item => escapeCsvCell(row[item.key])).join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`\uFEFF${lines.join('\r\n')}`);
}

module.exports = { sendCsv };
