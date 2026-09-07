const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const events = require('../../server/events');

function createResponse() {
  const response = new EventEmitter();
  response.chunks = [];
  response.ended = false;
  response.writableEnded = false;
  response.destroyed = false;
  response.write = (chunk) => {
    response.chunks.push(chunk);
    return true;
  };
  response.end = () => {
    response.ended = true;
    response.writableEnded = true;
  };
  return response;
}

test.afterEach(() => {
  events.closeAll();
});

test('SSE clients receive initial state and broadcast frames', () => {
  const first = createResponse();
  const second = createResponse();

  events.addClient(first);
  events.addClient(second);

  assert.equal(events.clientCount(), 2);
  assert.deepEqual(first.chunks, ['event: state\ndata: null\n\n']);
  assert.deepEqual(second.chunks, ['event: state\ndata: null\n\n']);

  events.emit('task', { id: 7, status: 'running' });

  const frame = 'event: task\ndata: {"id":7,"status":"running"}\n\n';
  assert.equal(first.chunks.at(-1), frame);
  assert.equal(second.chunks.at(-1), frame);
});

test('SSE clients are removed on close or error', () => {
  const closed = createResponse();
  const errored = createResponse();

  events.addClient(closed);
  events.addClient(errored);
  closed.emit('close');
  assert.equal(events.clientCount(), 1);

  errored.emit('error', new Error('disconnected'));
  assert.equal(events.clientCount(), 0);
});

test('closeAll ends every SSE response and clears registry', () => {
  const first = createResponse();
  const second = createResponse();
  events.addClient(first);
  events.addClient(second);

  events.closeAll();

  assert.equal(first.ended, true);
  assert.equal(second.ended, true);
  assert.equal(events.clientCount(), 0);
});
