// EPUB-3-Export des erkannten Texts (z. B. für „Send to Kindle“ oder andere Reader-Apps).

import * as db from './db.js';
import { buildFlow } from './textproc.js';
import { loadJSZip } from './zip.js';
import { inlineXhtml, parseBlock, tableXhtml } from './rich.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PAGES_PER_FILE = 20;

export async function exportEpub(bookId) {
  const JSZip = await loadJSZip();
  const book = await db.getBook(bookId);
  const pages = await db.getPagesMeta(bookId);
  const figMap = new Map();
  for (const f of await db.getFiguresOfBook(bookId)) {
    if (!figMap.has(f.pageId)) figMap.set(f.pageId, []);
    figMap.get(f.pageId).push(f);
  }
  const flow = buildFlow(pages, figMap).filter((f) => !f.placeholder);
  const figFiles = [];
  const uuid = 'urn:uuid:openbook-' + book.id;
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

  // Text in Dateien zu je ~20 Buchseiten aufteilen
  const files = [];
  let cur = null;
  for (const f of flow) {
    const chunk = Math.floor(f.pageIndex / PAGES_PER_FILE);
    if (!cur || cur.chunk !== chunk) {
      cur = { chunk, paras: [], from: f.pageIndex + 1, to: f.pageIndex + 1 };
      files.push(cur);
    }
    if (f.figure) {
      const name = `fig-${f.figure.id}.jpg`;
      zip.file('OEBPS/' + name, f.figure.image);
      figFiles.push(name);
      const cap = f.caption || f.figure.caption || '';
      cur.paras.push({ html: `<figure><img src="${name}" alt="${esc(cap || 'Abbildung')}"/>${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}</figure>` });
    } else {
      const inner = inlineXhtml(f.md || f.text);
      if (f.block === 'table') cur.paras.push({ html: tableXhtml(parseBlock(f.md)) });
      else if (f.block === 'fn') cur.paras.push({ html: `<p class="fn"><sup>${esc(f.label || '')}</sup> ${inner}</p>` });
      else if (f.block === 'h1') cur.paras.push({ html: `<h2>${inner}</h2>` });
      else if (f.block === 'h2') cur.paras.push({ html: `<h3>${inner}</h3>` });
      else if (f.block === 'li') cur.paras.push({ html: `<p class="li l${Math.min(4, f.level || 0)}${f.ordered ? ' ol' : ''}">${f.ordered ? '' : ['•', '◦', '▪', '•', '◦'][Math.min(4, f.level || 0)] + ' '}${inner}</p>` });
      else cur.paras.push({ html: `<p>${inner}</p>` });
    }
    cur.to = Math.max(cur.to, f.pageIndex + 1, ...(f.continues || []).map((c) => c.pageIndex + 1));
  }
  const xhtml = (title, body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="de" lang="de">
<head><meta charset="UTF-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${body}</body></html>`;

  files.forEach((f, i) => {
    f.name = `text${String(i + 1).padStart(3, '0')}.xhtml`;
    f.title = `Seiten ${f.from}–${f.to}`;
    zip.file('OEBPS/' + f.name, xhtml(f.title, f.paras.map((p) => (typeof p === 'string' ? `<p>${esc(p)}</p>` : p.html)).join('\n')));
  });

  zip.file('OEBPS/style.css', 'body{margin:0 5%;} p{margin:0;text-indent:1.4em;text-align:justify;} p:first-child{text-indent:0;} h1{text-align:center;font-weight:normal;margin:30% 0 0.5em;} figure{margin:1em 0;text-align:center;page-break-inside:avoid;} figure img{max-width:100%;max-height:90vh;} figcaption{font-size:0.85em;font-style:italic;} h2,h3{text-align:left;margin:1em 0 0.4em;page-break-after:avoid;} h2{font-size:1.3em;} h3{font-size:1.1em;} h2+p,h3+p{text-indent:0;} p.li{text-indent:-1em;margin:0.1em 0;text-align:left;} p.l0{margin-left:1.2em;} p.l1{margin-left:2.6em;} p.l2{margin-left:4em;} p.l3{margin-left:5.4em;} p.l4{margin-left:6.8em;} p.ol{text-indent:-1.4em;} .author{text-align:center;font-style:italic;} table{border-collapse:collapse;margin:0.8em 0;font-size:0.9em;} td,th{border:1px solid #999;padding:0.2em 0.4em;text-align:left;vertical-align:top;} p.fn{font-size:0.85em;text-indent:0;margin-top:0.3em;}');

  const hasCover = !!book.cover;
  if (hasCover) zip.file('OEBPS/cover.jpg', book.cover);
  zip.file('OEBPS/title.xhtml', xhtml(book.title,
    `<section epub:type="titlepage">${hasCover ? '<div style="text-align:center"><img src="cover.jpg" alt="Cover" style="max-width:100%;max-height:95vh"/></div>' : ''}<h1>${esc(book.title)}</h1>${book.author ? `<p class="author">${esc(book.author)}</p>` : ''}</section>`));

  zip.file('OEBPS/nav.xhtml', xhtml('Inhalt', `<nav epub:type="toc" id="toc"><h1>Inhalt</h1><ol>
<li><a href="title.xhtml">${esc(book.title)}</a></li>
${files.map((f) => `<li><a href="${f.name}">${esc(f.title)}</a></li>`).join('\n')}
</ol></nav>`));

  // NCX für ältere Reader
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uuid}"/></head>
<docTitle><text>${esc(book.title)}</text></docTitle><navMap>
<navPoint id="n0" playOrder="1"><navLabel><text>${esc(book.title)}</text></navLabel><content src="title.xhtml"/></navPoint>
${files.map((f, i) => `<navPoint id="n${i + 1}" playOrder="${i + 2}"><navLabel><text>${esc(f.title)}</text></navLabel><content src="${f.name}"/></navPoint>`).join('\n')}
</navMap></ncx>`);

  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="de">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${uuid}</dc:identifier>
    <dc:title>${esc(book.title)}</dc:title>
    ${book.author ? `<dc:creator>${esc(book.author)}</dc:creator>` : ''}
    <dc:language>de</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
    ${hasCover ? '<meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
    ${hasCover ? '<item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>' : ''}
    ${files.map((f, i) => `<item id="t${i + 1}" href="${f.name}" media-type="application/xhtml+xml"/>`).join('\n    ')}
    ${figFiles.map((n, i) => `<item id="img${i + 1}" href="${n}" media-type="image/jpeg"/>`).join('\n    ')}
  </manifest>
  <spine toc="ncx">
    <itemref idref="title"/>
    ${files.map((f, i) => `<itemref idref="t${i + 1}"/>`).join('\n    ')}
  </spine>
</package>`);

  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}
