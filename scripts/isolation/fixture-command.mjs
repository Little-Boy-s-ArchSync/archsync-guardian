// Shared by the real authored stdin payload and deterministic regression tests.
// Docker's reserved setup code keeps process infrastructure failures inconclusive.
export function checkedFixtureExit(result) {
  if (!result || !Number.isInteger(result.status) || result.status < 0 || result.status > 255 || result.signal || result.error) return 125;
  return result.status;
}
