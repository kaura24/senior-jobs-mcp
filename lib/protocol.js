'use strict';

const jobs = require('./jobs');
const curation = require('./curation');
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const conditionProperties = {
  keyword: { type: 'string', maxLength: 200, description: 'Work keyword. Substring in an individual observed title, organization, region or occupation field. Empty string clears the prior work filter.' },
  region: { type: 'string', maxLength: 200, description: 'Work region substring in raw workPlcNm; missing places are unknown, not a definite mismatch. Empty string clears the prior region.' },
  employmentCode: { type: 'string', maxLength: 200, description: 'Exact raw source code from observed options. Human-readable employment labels are not mapped. Empty string clears this filter.' },
  anyRegion: { type: 'boolean', default: false, description: 'True only when the user explicitly has no region preference; do not repeat the region question.' },
  anyWork: { type: 'boolean', default: false, description: 'True only when the user explicitly has no work type preference; clear keyword and do not repeat the work question.' },
};
const tools = [
  { name: 'describe_search_options', title: 'Describe stored job search options',
    description: 'For a vague request like 어떤 일자리가 있어?, inspect observed options before searching. Supply current stated conditions to obtain distributions after filtering, match/unknown/mismatch counts, conditionState and one or two next-question hints. Ask only unanswered region/work questions; do not fetch all details. Static partial sample; no upstream or AI requests.',
    inputSchema: { type: 'object', properties: conditionProperties, additionalProperties: false }, annotations },
  { name: 'search_jobs', title: 'Search stored senior job candidates',
    description: 'Search after the user supplies work conditions. Send updated current conditions, replacing changed or cleared prior values; normally limit 3. Returns raw-field evidence, applied filters, before/after counts and all-filtered distributions before paging. Unknown missing fields are distinguished from mismatch. Zero is only in this partial static sample; ask before broadening. Rechecks KST period and raw 접수중. Include answerNotice.text once in the answer: snapshot date, 314 listings, one cached summary and 313 details not collected. Never infer salary, hours, age or qualifications.',
    inputSchema: { type: 'object', properties: {
      ...conditionProperties,
      offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    }, additionalProperties: false }, annotations },
  { name: 'get_job_details', title: 'Get cached job details',
    description: 'Use a real returned ID only for a selected job or explicitly requested detail/contact. Optionally supply current conditions for filter evidence. Raw list fields and one cached observation summary are separate; zero full details, other 313 not collected. Include returned answerNotice.text once in the answer, including snapshot date and exact detail coverage. Missing salary, exact hours, age and qualifications require recruiter confirmation; title phrases are only title evidence. Cached public contact is not connectivity verified. No upstream or AI requests.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 100 }, ...conditionProperties }, required: ['id'], additionalProperties: false }, annotations },
];

function error(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

function respond(message, now = new Date()) {
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(null, -32600, 'Invalid Request');
  if (!Object.hasOwn(message, 'id')) return null;
  if (typeof message.id !== 'string' && typeof message.id !== 'number' && message.id !== null) return error(null, -32600, 'Invalid request id');
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    return reply({ protocolVersion: versions.includes(requested) ? requested : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'senior-jobs-static-poc', version: curation.version },
      instructions: curation.instructions });
  }
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools });
  if (message.method !== 'tools/call') return error(message.id, -32601, 'Method not found');
  const handlers = { describe_search_options: jobs.describeOptions, search_jobs: jobs.searchJobs, get_job_details: jobs.getDetails };
  const name = message.params?.name;
  if (!Object.hasOwn(handlers, name || '')) return error(message.id, -32602, 'Unknown tool');
  try {
    const data = handlers[name](message.params.arguments ?? {}, now);
    return reply({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });
  } catch (cause) {
    return reply({ content: [{ type: 'text', text: cause.message }], isError: true });
  }
}

module.exports = { tools, respond, error };
