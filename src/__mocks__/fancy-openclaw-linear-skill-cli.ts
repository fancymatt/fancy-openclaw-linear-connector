/**
 * Test stub for fancy-openclaw-linear-skill-cli.
 * This package is not installed in the test environment.
 * All exports return sensible no-op defaults.
 */
export function getAgentWorkspaceDir(_name: string): string {
  return `/tmp/test-agent-workspace/${_name}`;
}
export function getLinearSecretPath(_name: string): string {
  return `/tmp/test-secrets/${_name}/linear.env`;
}
