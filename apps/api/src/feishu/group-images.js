const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_GROUP_IMAGES = 3;

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('image_format_unsupported');
}

/** Fetch only resources attached to this message; never fetch URLs from chat text. */
export async function downloadGroupImages(channel, message) {
  const resources = [...new Map((message.resources ?? []).filter((r) => r.type === 'image').map((r) => [r.fileKey, r])).values()];
  if (resources.length > MAX_GROUP_IMAGES) throw new Error('too_many_images');
  if (message.rawContentType === 'image' && !resources.length) throw new Error('image_key_missing');
  const images = [];
  for (const resource of resources) {
    let timer;
    let stream;
    let expired = false;
    const operation = (async () => {
      const response = await channel.rawClient.im.v1.messageResource.get({
        path: { message_id: message.messageId, file_key: resource.fileKey }, params: { type: 'image' }
      });
      stream = response.getReadableStream();
      if (expired) { stream.destroy(); throw new Error('image_download_timeout'); }
      const parts = [];
      let size = 0;
      for await (const part of stream) {
        const bytes = Buffer.from(part);
        size += bytes.length;
        if (size > MAX_BYTES) { stream.destroy(); throw new Error('image_too_large'); }
        parts.push(bytes);
      }
      const bytes = Buffer.concat(parts);
      return { type: 'image_url', image_url: { url: `data:${imageMime(bytes)};base64,${bytes.toString('base64')}` } };
    })();
    try {
      images.push(await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; stream?.destroy(); reject(new Error('image_download_timeout')); }, 20_000);
      })]));
    } finally { clearTimeout(timer); }
  }
  return images;
}
