import test from 'node:test';
import assert from 'node:assert/strict';
import { readSse } from '../src/ark/sse.js';

const encoder = new TextEncoder();
function responseOf(chunks, callbacks = {}) {
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === chunks.length) controller.close();
      else controller.enqueue(chunks[offset++]);
    },
    cancel: callbacks.cancel
  }));
}
const collect = async (response, options) => {
  const events = [];
  for await (const event of readSse(response, options)) events.push(event);
  return events;
};
const hasCode = code => error => error.code === code;

test('SSE preserves UTF-8 and frames across every byte boundary, CRLF, comments and multiline data', async () => {
  const bytes = encoder.encode(': heartbeat\r\n\r\nevent: response.delta\r\ndata: 第一行\r\ndata: 第二行 😀\r\n\r\ndata: [DONE]\n\n');
  const expected = [{ event: 'response.delta', data: '第一行\n第二行 😀' }, { event: 'message', data: '[DONE]' }];
  assert.deepEqual(await collect(responseOf([...bytes].map(byte => new Uint8Array([byte])))), expected);
  assert.deepEqual(await collect(responseOf([bytes])), expected, 'multiple events can share a network chunk');
});

test('SSE rejects missing body, partial final frames and invalid UTF-8 without publishing the tail', async () => {
  await assert.rejects(collect(new Response(null)), hasCode('invalid_response'));
  for (const tail of ['data: {"partial":', 'data: {"complete":true}\n', 'event: result\n']) {
    await assert.rejects(collect(responseOf([encoder.encode(tail)])), hasCode('stream_incomplete'));
  }
  await assert.rejects(collect(responseOf([new Uint8Array([0xff])])), hasCode('invalid_response'));
  await assert.rejects(collect(responseOf([encoder.encode('data: '), new Uint8Array([0xe4, 0xb8])])), hasCode('invalid_response'));
});

test('SSE enforces event and total byte limits and cancels the reader', async () => {
  let canceled = 0;
  await assert.rejects(collect(responseOf([encoder.encode('data: abcdefghijklmnop\n\n'), encoder.encode('data: later\n\n')], { cancel: () => { canceled++; } }), { maxEventBytes: 12 }), hasCode('stream_limit_exceeded'));
  assert.equal(canceled, 1);
  await assert.rejects(collect(responseOf([encoder.encode('data: 1\n\ndata: 2\n\n')]), { maxTotalBytes: 12 }), hasCode('stream_limit_exceeded'));
});

test('SSE propagates reader errors even after a valid event', async () => {
  let reads = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (!reads++) controller.enqueue(encoder.encode('data: {"valid":true}\n\n'));
    else controller.error(new Error('connection reset'));
  } }));
  await assert.rejects(collect(response), hasCode('network_error'));
});

test('SSE abort interrupts a hanging read and never awaits a hanging cancel hook', async () => {
  const controller = new AbortController();
  let canceled = false;
  const response = new Response(new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}); } }));
  const pending = collect(response, { signal: controller.signal });
  const rejection = assert.rejects(pending, hasCode('timeout'));
  controller.abort();
  await rejection;
  assert.equal(canceled, true);
  assert.equal(response.body.locked, false);
});

test('SSE early consumer return releases the body and signals cancellation', async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); },
    cancel() { canceled = true; }
  }));
  for await (const event of readSse(response)) { assert.equal(event.data, '[DONE]'); break; }
  assert.equal(canceled, true);
  assert.equal(response.body.locked, false);
});
