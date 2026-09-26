import path from 'node:path';
import { readFile, lstat, realpath } from 'node:fs/promises';

export async function readKnowledgePage(repository, documentId, page, { withType = false } = {}) {
  const missing = () => Object.assign(new Error('原页不存在或当前不可访问。'), { statusCode: 404 });
  if (!/^KP-[a-f0-9]{8}$/.test(documentId) || !Number.isSafeInteger(page) || page < 1 || page > 100000) throw missing();
  const data = await repository.read();
  const visible = data.knowledgePoints.some(point => !point.archived && !point.hidden && point.sourceDocumentId === documentId
    && point.sourceAnchors?.some(anchor => anchor.documentId === documentId && anchor.pdfPage === page));
  if (!visible) throw missing();
  const root = path.resolve(path.dirname(repository.filePath), 'knowledge-library');
  let file = path.join(root, documentId, 'structured-v1', 'pages', `${String(page).padStart(4, '0')}.jpg`), mime = 'image/jpeg';
  if (withType) {
    try { await lstat(file); } catch (e) {
      if (e.code !== 'ENOENT') throw missing();
      file = path.join(root, documentId, 'source.pdf'); mime = 'application/pdf';
    }
  }
  try {
    for (let current = file; current !== root; current = path.dirname(current)) if ((await lstat(current)).isSymbolicLink()) throw missing();
    const resolved = await realpath(file), resolvedRoot = await realpath(root);
    const relative = path.relative(resolvedRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw missing();
    const bytes = await readFile(resolved);
    return withType ? { bytes, mime } : bytes;
  } catch (error) { if (error.statusCode) throw error; throw missing(); }
}
