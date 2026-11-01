'use strict';

// Compatibility facade for integrations that still use the former module path.
module.exports = {
  ...require('./scalper/order-inspection'),
  ...require('./scalper/telegram-notifier'),
};
