import { authorize, remoteKeys } from './auth.mjs';
import { operation, InvalidOperation } from './storage.mjs';
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidOperation();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 6_000_000) { await reader.cancel(); throw new InvalidOperation(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new InvalidOperation(); }
}
export function createBridge(keys = remoteKeys) {
  return { async fetch(request, env) {
    const reply = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    if (new URL(request.url).pathname !== '/storage' || request.method !== 'POST') return reply(404, { errorCode: 'NOT_FOUND' });
    if (!await authorize(request, keys)) return reply(401, { errorCode: 'UNAUTHORIZED' });
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return reply(415, { errorCode: 'INVALID_CONTENT_TYPE' });
    try {
      const query = operation(await readBody(request));
      const result = await env.DB.prepare(query.sql).bind(...query.parameters).all();
      if (result.success !== true || !Array.isArray(result.results)) throw new Error('D1_QUERY_FAILED');
      return reply(200, { rows: result.results });
    } catch (cause) {
      if (cause instanceof InvalidOperation || cause instanceof SyntaxError || cause instanceof TypeError) return reply(400, { errorCode: 'INVALID_STORAGE_OPERATION' });
      console.log(JSON.stringify({ event: 'd1_binding_failed', errorCode: 'STORAGE_UNAVAILABLE' }));
      return reply(503, { errorCode: 'STORAGE_UNAVAILABLE' });
    }
  } };
}
export default createBridge();
