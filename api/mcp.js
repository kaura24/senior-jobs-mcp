'use strict';

const { respond, error } = require('../lib/protocol');
const maximumBodyBytes = 65536;

async function readBody(req) {
  if (req.body !== undefined) {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(text) > maximumBodyBytes) throw new Error('Request body too large');
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBodyBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Protocol-Version');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, data) => {
    res.statusCode = status;
    if (data !== undefined) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); }
    else res.end();
  };
  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      if (origin.protocol !== 'https:' || origin.origin !== req.headers.origin) return send(403, { error: 'Invalid Origin' });
    } catch { return send(403, { error: 'Invalid Origin' }); }
  }
  if (req.method === 'OPTIONS') return send(204);
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return send(405, { error: 'Use MCP JSON-RPC POST; no SSE stream is provided.' }); }
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return send(415, { error: 'Content-Type must be application/json' });
  let message;
  try { message = await readBody(req); }
  catch (cause) { return send(cause.message === 'Request body too large' ? 413 : 400, error(null, -32700, 'Invalid JSON request')); }
  const result = respond(message);
  return result === null ? send(202) : send(200, result);
};
