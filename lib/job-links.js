'use strict';

function detailLink(jobId) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) throw new Error('Unsupported source job ID for the cached detail tool.');
  return { label: '저장 상세 조회', url: null, jobId,
    sourceUrlState: 'not_available_in_stored_evidence',
    targetKind: 'cached_detail_tool_fallback',
    clientAction: 'call_tool_if_available_otherwise_disclose_not_queried',
    tool: { name: 'get_job_details', arguments: { id: jobId } } };
}

module.exports = { detailLink };
