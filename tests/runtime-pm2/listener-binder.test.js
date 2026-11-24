import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

test('bindZaloListeners: registers 6 listeners on first bind', async () => {
  const { bindZaloListeners } = await import('../../src/runtime/listener-binder.js');
  const emitter = new EventEmitter();
  const binder = bindZaloListeners(emitter, {
    message: () => {},
    group_event: () => {},
    undo: () => {},
    reaction: () => {},
    error: () => {},
    closed: () => {},
  });
  assert.equal(binder.size, 6);
  const counts = binder.getListenerCounts();
  assert.equal(counts.message, 1);
  assert.equal(counts.group_event, 1);
  assert.equal(counts.undo, 1);
  assert.equal(counts.reaction, 1);
  assert.equal(counts.error, 1);
  assert.equal(counts.closed, 1);
});

test('bindZaloListeners: dispose removes only the registered callbacks', async () => {
  const { bindZaloListeners } = await import('../../src/runtime/listener-binder.js');
  const emitter = new EventEmitter();

  // Pre-existing library listener
  const libraryCallback = () => {};
  emitter.on('message', libraryCallback);

  const binder = bindZaloListeners(emitter, {
    message: () => {},
    error: () => {},
  });
  assert.equal(emitter.listenerCount('message'), 2); // library + ours

  const removed = binder.dispose();
  assert.equal(removed, 2);

  // Library listener must still be there
  assert.equal(emitter.listenerCount('message'), 1);
  assert.equal(emitter.listenerCount('error'), 0);
});

test('bindZaloListeners: 100 reconnect cycles keep listener count at baseline', async () => {
  const { bindZaloListeners, ListenerLeakDetector } = await import('../../src/runtime/listener-binder.js');
  const emitter = new EventEmitter();

  // Pre-existing library listener (e.g. zca-js internal handler)
  emitter.on('message', () => {});
  emitter.on('group_event', () => {});

  // First bind — establish baseline
  const baselineCallbacks = {
    message: () => {},
    group_event: () => {},
    undo: () => {},
    reaction: () => {},
    error: () => {},
    closed: () => {},
  };
  let currentBinder = bindZaloListeners(emitter, baselineCallbacks);
  const detector = new ListenerLeakDetector({ threshold: 3 });
  detector.setBaseline(currentBinder.getListenerCounts());

  // Simulate 100 reconnect cycles: dispose old binder, then create a new one
  for (let i = 0; i < 100; i++) {
    currentBinder.dispose();
    currentBinder = bindZaloListeners(emitter, baselineCallbacks);
  }

  // Final dispose so we end with NO app listeners
  currentBinder.dispose();

  // Listen counts should equal baseline (1 library for message/group_event, 0 for others)
  const finalCounts = {
    message: emitter.listenerCount('message'),
    group_event: emitter.listenerCount('group_event'),
    undo: emitter.listenerCount('undo'),
    reaction: emitter.listenerCount('reaction'),
    error: emitter.listenerCount('error'),
    closed: emitter.listenerCount('closed'),
  };

  const { leaked } = detector.check(finalCounts);
  assert.deepEqual(leaked, [], `Listener leak detected: ${JSON.stringify(leaked)}, counts: ${JSON.stringify(finalCounts)}`);
  // message: 1 (library) + 0 (ours, disposed) = 1
  assert.equal(finalCounts.message, 1, `Expected 1 (library only) for message, got ${finalCounts.message}`);
  assert.equal(finalCounts.group_event, 1, `Expected 1 (library only) for group_event, got ${finalCounts.group_event}`);
  assert.equal(finalCounts.undo, 0, `Expected 0 for undo, got ${finalCounts.undo}`);
});

test('ListenerLeakDetector: detects when binder never disposed', async () => {
  const { bindZaloListeners, ListenerLeakDetector } = await import('../../src/runtime/listener-binder.js');
  const emitter = new EventEmitter();

  const baseline = bindZaloListeners(emitter, {
    message: () => {},
    group_event: () => {},
  });
  const detector = new ListenerLeakDetector({ threshold: 2 });
  detector.setBaseline(baseline.getListenerCounts());

  // Bind without disposing — should be detected as leak after threshold
  for (let i = 0; i < 3; i++) {
    bindZaloListeners(emitter, {
      message: () => {},
      group_event: () => {},
    });
    const check = detector.check({
      message: emitter.listenerCount('message'),
      group_event: emitter.listenerCount('group_event'),
    });
    if (i === 2) {
      // After 3 binds without dispose, leak should be detected
      assert.ok(check.leaked.length > 0 || i < 2, `Expected leak at i=2, got: ${JSON.stringify(check)}`);
    }
  }
});

test('bindZaloListeners: only binds provided handlers', async () => {
  const { bindZaloListeners } = await import('../../src/runtime/listener-binder.js');
  const emitter = new EventEmitter();
  const binder = bindZaloListeners(emitter, {
    message: () => {},
    // group_event, undo, reaction, error, closed are missing
  });
  assert.equal(binder.size, 1);
  assert.equal(emitter.listenerCount('message'), 1);
  assert.equal(emitter.listenerCount('group_event'), 0);
});

test('bindZaloListeners: throws on non-emitter', async () => {
  const { bindZaloListeners } = await import('../../src/runtime/listener-binder.js');
  assert.throws(() => bindZaloListeners(null, { message: () => {} }), /must be an EventEmitter/);
  assert.throws(() => bindZaloListeners({}, { message: () => {} }), /must be an EventEmitter/);
});

test('bindZaloListeners: handles undefined handler gracefully', async () => {
  const { bindZaloListeners } = await import('../../src/runtime/listener-binder.js');
  const emitter = new EventEmitter();
  // All undefined should not register anything but not crash
  const binder = bindZaloListeners(emitter, {});
  assert.equal(binder.size, 0);
});

test('bindZaloListeners: callbacks actually fire on emit', async () => {
  const { bindZaloListeners } = await import('../../src/runtime/listener-binder.js');
  const emitter = new EventEmitter();
  let messageCount = 0;
  let errorCount = 0;
  const binder = bindZaloListeners(emitter, {
    message: () => { messageCount++; },
    error: () => { errorCount++; },
  });
  emitter.emit('message', { data: 'hi' });
  emitter.emit('error', new Error('x'));
  assert.equal(messageCount, 1);
  assert.equal(errorCount, 1);

  // Dispose
  binder.dispose();
  emitter.emit('message', { data: 'after dispose' });
  assert.equal(messageCount, 1, 'Should not fire after dispose');
});
