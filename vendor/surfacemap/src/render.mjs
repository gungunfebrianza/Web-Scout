import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEMPLATE = fileURLToPath(new URL('./template.html', import.meta.url));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// One self-contained HTML file: the graph is inlined as JSON and drawn by a small script in the page.
// Deterministic on purpose (no dates, no random ids) so `surfacemap check` can diff it against the file on disk.
export function renderHtml(graph) {
  const template = fs.readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n');
  // "<" is escaped so no node name can close the script tag or open a comment.
  const BS = String.fromCharCode(92);
  const escapeChar = (c) => BS + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  const data = JSON.stringify(graph).replace(new RegExp('[<' + String.fromCharCode(0x2028, 0x2029) + ']', 'g'), escapeChar);
  return template.replace('{{TITLE}}', () => escapeHtml(`${graph.project} surface map`)).replace('{{DATA}}', () => data);
}
