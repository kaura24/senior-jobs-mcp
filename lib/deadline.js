'use strict';
async function withinDeadline(task, milliseconds, timeoutError) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('Request deadline exceeded', 'AbortError'));
      reject(timeoutError());
    }, milliseconds);
  });
  try { return await Promise.race([Promise.resolve().then(() => task(controller.signal)), deadline]); }
  finally { clearTimeout(timer); }
}
module.exports = { withinDeadline };
