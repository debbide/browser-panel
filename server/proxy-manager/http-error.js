'use strict';

// Errors that carry an intended HTTP status. `safeMessage` marks a message that
// was written for the client; anything without it is replaced by a generic
// message so SQL, crypto and parser internals never leak.
function httpError(statusCode, message, { safeMessage = true } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.safeMessage = safeMessage;
  return error;
}

const badRequest = (message) => httpError(400, message);
const notFound = (message) => httpError(404, message);
const conflict = (message) => httpError(409, message);
const serviceUnavailable = (message) => httpError(503, message);

module.exports = { httpError, badRequest, notFound, conflict, serviceUnavailable };
