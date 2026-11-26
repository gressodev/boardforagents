// An error with an HTTP status. The handler in api/index.js answers it as { error: message }.
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    if (extra) this.extra = extra; // optional extra JSON fields, e.g. retry_after
  }
}

module.exports = { HttpError };
