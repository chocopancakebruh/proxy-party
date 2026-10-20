const { randomUUID } = require('node:crypto');
const { isConnectionId, LEGACY } = require('./ConnectionRegistry');

const PROVIDER_IDS = Object.freeze(LEGACY.map(connection => connection.id));
const ERROR_CATEGORIES = Object.freeze([
  'invalid_request', 'authentication', 'timeout', 'upstream_error', 'cancelled', 'internal_error'
]);
const trackedResponses = new WeakMap();

function safeCategory(category) {
  return ERROR_CATEGORIES.includes(category) ? category : 'upstream_error';
}

function categoryForStatus(status) {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 400 && status < 500) return 'invalid_request';
  return 'upstream_error';
}

function markActivityFailure(res, category = 'upstream_error') {
  trackedResponses.get(res)?.fail(category);
}

function createRequestActivity({ now = Date.now, limit = 100 } = {}) {
  const capacity = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100;
  let requests = [];
  let activeRequests = 0;
  const timestamp = () => {
    const value = now();
    return Number.isFinite(value) && Math.abs(value) <= 8640000000000000 ? Math.trunc(value) : Date.now();
  };
  const duration = (start, end) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, end - start));

  return {
    track(req, res, { providerId, streaming = false }) {
      if (!isConnectionId(providerId)) throw new TypeError('Unknown activity provider');
      const existing = trackedResponses.get(res);
      if (existing) return existing;
      const started = timestamp();
      const entry = {
        id: randomUUID(), providerId, startedAt: new Date(started).toISOString(),
        durationMs: 0, status: 'running', httpStatus: null, streaming: streaming === true
      };
      const record = { entry, started };
      let finished = false;
      let failureCategory;
      const handle = Object.freeze({
        setStreaming(value) {
          if (!finished && typeof value === 'boolean') entry.streaming = value;
        },
        fail(category = 'upstream_error') {
          if (!finished) failureCategory ||= safeCategory(category);
        }
      });
      const cleanup = () => {
        req.off('aborted', onAborted);
        res.off('finish', onFinish);
        res.off('close', onClose);
      };
      const finish = completed => {
        if (finished) return;
        finished = true;
        activeRequests -= 1;
        cleanup();
        entry.durationMs = duration(started, timestamp());
        const status = res.statusCode;
        if ((completed || res.headersSent) && Number.isInteger(status) && status >= 100 && status <= 599) {
          entry.httpStatus = status;
        }
        if (failureCategory) {
          entry.status = failureCategory === 'cancelled' ? 'cancelled' : 'error';
          entry.errorCategory = failureCategory;
        } else if (!completed) {
          entry.status = 'cancelled';
          entry.errorCategory = 'cancelled';
        } else if (entry.httpStatus === null || entry.httpStatus >= 400) {
          entry.status = 'error';
          entry.errorCategory = categoryForStatus(entry.httpStatus);
        } else {
          entry.status = 'success';
        }
      };
      const onFinish = () => finish(true);
      const onClose = () => finish(res.writableFinished === true);
      const onAborted = () => finish(false);
      trackedResponses.set(res, handle);
      activeRequests += 1;
      requests.unshift(record);
      if (requests.length > capacity) requests.length = capacity;
      req.once('aborted', onAborted);
      res.once('finish', onFinish);
      res.once('close', onClose);
      if (res.writableFinished) finish(true);
      else if (req.aborted || res.destroyed) finish(false);
      return handle;
    },
    list() {
      const current = timestamp();
      return {
        requests: requests.map(({ entry, started }) => ({
          ...entry,
          durationMs: entry.status === 'running' ? duration(started, current) : entry.durationMs
        }))
      };
    },
    activeCount() { return activeRequests; },
    clear() { requests = []; }
  };
}

module.exports = { createRequestActivity, markActivityFailure, PROVIDER_IDS, ERROR_CATEGORIES };
