'use strict';
// Eigene Datei, damit die Oberfläche (Browser-Bündel) buildThink ohne Node-Module (http) laden kann.

/**
 * Baut den think-Parameter passend zum Modell.
 * gpt-oss kennt nur Stufen (low/medium/high), andere Denk-Modelle true/false.
 */
function buildThink(modelName, capabilities, level) {
  const caps = capabilities || [];
  if (!caps.includes('thinking')) return undefined;
  if (/gpt-oss/i.test(modelName)) {
    return level === 'off' ? 'low' : level || 'medium';
  }
  return level !== 'off';
}

module.exports = { buildThink };
