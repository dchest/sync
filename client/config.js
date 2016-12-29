/**
 * This file includes base config vars.
 * Additional config comes from the browser client when it initializes sync.
 */

module.exports = {
  // Set this to the origins where client.html may be loaded
  clientOrigins: ['http://localhost:8000', 'chrome-extension://mnojpmjdmbbfmejpflffifhffcmidifd'],
  // 2-byte encryption nonce counter, rotated periodically
  nonceCounter: 0
}
