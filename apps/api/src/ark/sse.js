function failure(code) {
  return Object.assign(new Error(`Ark response stream failed: ${code}`), { code });
}

function readWithSignal(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(failure('timeout'));
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(failure('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([reader.read(), interrupted]).finally(() => signal.removeEventListener('abort', onAbort));
}

async function* bodyChunks(response, { signal, maxTotalBytes }) {
  if (!response?.body?.getReader || !Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0) throw failure('invalid_response');
  let reader;
  try { reader = response.body.getReader(); } catch { throw failure('invalid_response'); }
  let finished = false, total = 0;
  try {
    while (true) {
      let next;
      try { next = await readWithSignal(reader, signal); } catch (error) {
        if (signal?.aborted || ['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'timeout') throw failure('timeout');
        throw failure('network_error');
      }
      if (signal?.aborted) throw failure('timeout');
      if (next.done) { finished = true; return; }
      if (!(next.value instanceof Uint8Array)) throw failure('invalid_response');
      total += next.value.byteLength;
      if (total > maxTotalBytes) throw failure('stream_limit_exceeded');
      yield next.value;
    }
  } finally {
    // A provider's cancel hook may never settle; it must not delay the timeout.
    if (!finished) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    }
    try { reader.releaseLock(); } catch {}
  }
}

function decode(decoder, chunk, streaming) {
  try { return decoder.decode(chunk, { stream: streaming }); } catch { throw failure('invalid_response'); }
}

/** Read a bounded UTF-8 body, retaining cancellation throughout body consumption. */
export async function readResponseText(response, { signal, maxTotalBytes = 16777216 } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts = [];
  for await (const chunk of bodyChunks(response, { signal, maxTotalBytes })) parts.push(decode(decoder, chunk, true));
  parts.push(decode(decoder, undefined, false));
  return parts.join('');
}

/** Parse SSE framing only. Consumers validate JSON and their own terminal event. */
export async function* readSse(response, { signal, maxEventBytes = 2097152, maxTotalBytes = 16777216 } = {}) {
  if (!Number.isFinite(maxEventBytes) || maxEventBytes <= 0) throw failure('invalid_response');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', event = '', data = [], eventBytes = 0, hasFields = false;
  function line(value, newlineBytes) {
    if (!value) {
      const result = data.length ? { event: event || 'message', data: data.join('\n') } : null;
      event = ''; data = []; eventBytes = 0; hasFields = false;
      return result;
    }
    eventBytes += Buffer.byteLength(value) + newlineBytes;
    if (eventBytes > maxEventBytes) throw failure('stream_limit_exceeded');
    if (value.startsWith(':')) return null;
    hasFields = true;
    const separator = value.indexOf(':');
    const field = separator < 0 ? value : value.slice(0, separator);
    let content = separator < 0 ? '' : value.slice(separator + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
    else if (field === 'event') event = content;
    return null;
  }
  function* drain(final = false) {
    let offset = 0;
    while (offset < buffer.length) {
      const relative = buffer.slice(offset).search(/[\r\n]/);
      if (relative < 0) break;
      const end = offset + relative;
      if (buffer[end] === '\r' && end === buffer.length - 1 && !final) break;
      const width = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
      const result = line(buffer.slice(offset, end), width);
      offset = end + width;
      if (result) yield result;
    }
    buffer = buffer.slice(offset);
    if (eventBytes + Buffer.byteLength(buffer) > maxEventBytes) throw failure('stream_limit_exceeded');
  }
  for await (const chunk of bodyChunks(response, { signal, maxTotalBytes })) {
    buffer += decode(decoder, chunk, true);
    yield* drain();
  }
  buffer += decode(decoder, undefined, false);
  yield* drain(true);
  // EOF must not turn a partial final event into a completed response.
  if (buffer.length || hasFields || data.length) throw failure('stream_incomplete');
}
