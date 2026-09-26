import { MAX_PDF_BYTES, validatePdf } from '../knowledge/pdf-import.js';

export async function downloadGroupPdf(channel, message) {
  const resources = (message.resources || []).filter(r => r.type === 'file');
  if (resources.length !== 1 || !/\.pdf$/i.test(resources[0].fileName || '')) throw new Error('请发送一份 PDF 附件，其他文件格式暂不支持。');
  const resource = resources[0];
  let stream, expired = false, timer;
  try {
    const operation = (async () => {
      const response = await channel.rawClient.im.v1.messageResource.get({ path: { message_id: message.messageId, file_key: resource.fileKey }, params: { type: 'file' } });
      stream = response.getReadableStream();
      if (expired) { stream.destroy(); throw new Error('PDF 下载超时。'); }
      const chunks = []; let size = 0;
      for await (const chunk of stream) { const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > MAX_PDF_BYTES) { stream.destroy(); throw new Error('PDF 必须小于 10 MB。'); } chunks.push(bytes); }
      const bytes = Buffer.concat(chunks); validatePdf(resource.fileName, bytes);
      return { bytes, filename: resource.fileName };
    })();
    return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; stream?.destroy(); reject(new Error('PDF 下载超时。')); }, 30000); })]);
  } finally { clearTimeout(timer); }
}
