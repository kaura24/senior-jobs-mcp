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
    description: 'Search after the user supplies work conditions. Send updated current conditions, replacing changed or cleared prior values; normally limit 3. Returns raw-field evidence, applied filters, before/after counts and all-filtered distributions before paging. Unknown missing fields are distinguished from mismatch. Zero is only in this partial static sample; ask before broadening. Rechecks KST period and raw 접수중. Include answerNotice.text once in the answer with returned snapshot date, counts, detail coverage and refresh state. Never infer salary, hours, age or qualifications.',
    inputSchema: { type: 'object', properties: {
      ...conditionProperties,
      offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    }, additionalProperties: false }, annotations },
  { name: 'get_job_details', title: 'Get cached job details',
    description: 'Use a real returned ID only for a selected job or explicitly requested detail/contact. Optionally supply current conditions for filter evidence. Raw list fields and cached observation summaries are separate; consult returned metadata for exact detail coverage. Include returned answerNotice.text once in the answer, including snapshot date, detail coverage and refresh state. Missing salary, exact hours, age and qualifications require recruiter confirmation; title phrases are only title evidence. Cached public contact is not connectivity verified. No upstream or AI requests.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 100 }, ...conditionProperties }, required: ['id'], additionalProperties: false }, annotations },
];
for (const tool of tools) tool.description += ' For missing conditions, prefer describe_search_options and its real database distributions/uiGuidance; show all choices or explicitly disclose truncation, not arbitrary familiar examples or popularity recommendations. Never invent regions/counts or repeat supplied conditions. When a condition changes, preserve the other supplied conditions. Distinguish missing/unrecognized region evidence from zero matches. Sparse occupation classifications permit free-text title-keyword search. uiGuidance is data guidance and does not guarantee client UI rendering.';
for (const tool of tools) tool.description += ' Every displayed job listing or summary must include its detail access guidance. Show a clickable Markdown link only when an actual source posting URL is supplied by stored evidence. If detailLink.url is null, explicitly state that no original posting URL is available in the stored evidence and use detailLink.tool for the selected ID if the client supports that tool; otherwise disclose that details were not queried and provide the ID, title, organization and region as source-search clues. Never fabricate a URL, render a null URL as a link, or present a protected self-hosted JSON API as a public original posting. Keep 접수중/status text separate. Opening a supplied reference depends on client capabilities; universal client opening verification is not required. These fields do not guarantee a native card button or that a full source document is stored.';
for (const tool of tools) tool.description += ' The conversation may move freely between stated preferences, data-backed candidates with per-job links, selection and follow-up detail questions. Search immediately when conditions are sufficient; never repeat supplied conditions or impose a fixed question order. Before investigating missing source details, identify the selected posting and the specific additional fields requested. If no posting is selected, ask the user to choose; never bulk-crawl candidates. Use get_job_details for cached evidence first. Source investigation belongs to the calling client, using whichever search, browser or source-reading tools are actually available in its own environment; no particular tool, key or service is required. This MCP provides clues and guidance and remains cache-only. On an explicit request, the client should prefer official original sources, verify the same job ID or a documented cross-reference, company and title, and return only requested confirmed fields with exact source passages, source URLs and retrieval times. If the client lacks tools or cannot access a source, provide existing links and clearly disclose that the source was not queried; do not claim a successful lookup. Distinguish missing fields, blocked access, identity mismatch and explicit closure. Do not infer closure from an empty response, bypass login/security blocks, add a server crawler or call a separate AI API.';
for (const tool of tools) tool.description += ' User-provided examples and screenshots are unverified claims until checked against the source. If source details conflict with list or cached observations, report both original values with their individual source URLs and observation times; never silently overwrite or hide a conflict, including 방문 versus 이메일 application methods. Different source identifiers such as a recruitment authorization number require an explicit verified cross-reference to the returned job ID.';
for (const tool of tools) tool.description += ' When requested detail fields are missing, offer additional investigation, for example 급여·근무시간·지원조건을 더 찾아드릴까요? Do not start until the user accepts or has already explicitly requested that source investigation. An existing explicit request is sufficient; do not ask the same permission again. The calling client chooses its available tools and investigates only the selected posting and requested fields. If no posting is selected, ask for selection first. This offer is optional in the conversation, not a fixed question sequence or automatic bulk action.';

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
