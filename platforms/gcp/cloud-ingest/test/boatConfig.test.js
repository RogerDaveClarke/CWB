const test = require('node:test');
const assert = require('node:assert/strict');
const { gatewayConnectionError, gatewayRejectionError } = require('../boatConfig');

test('gateway client errors contain no internal or upstream details', () => {
  const connection = gatewayConnectionError();
  const rejection = gatewayRejectionError();

  assert.equal(connection.code, 'unavailable');
  assert.equal(connection.message, 'Could not reach the LoRaWAN gateway.');
  assert.equal(rejection.code, 'unavailable');
  assert.equal(rejection.message, 'The LoRaWAN gateway rejected the configuration request.');
  assert.doesNotMatch(`${connection.message} ${rejection.message}`, /https?:|token|environment|stack|response/i);
});