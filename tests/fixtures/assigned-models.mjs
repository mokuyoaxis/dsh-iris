import { modelPool } from '../../lib/models.js';

/** Explicitly assign the models needed by a fixture; never used by product code. */
function fixtureAssignments(providers) {
  const assignments = {};
  for (const model of modelPool(providers)) {
    for (const capability of model.capabilities) {
      (assignments[capability] ||= []).push(model.ref);
    }
  }
  return assignments;
}

export function assignFixtureModels(config) {
  for (const [capability, refs] of Object.entries(fixtureAssignments(config.allProviders()))) {
    config.setAssignmentOrder(capability, refs);
  }
}
