'use strict';

// Compatibility facade for integrations that still use the former module path.
module.exports = {
  ...require('./scalper/position-policy'),
  ...require('./scalper/state-store'),
};
