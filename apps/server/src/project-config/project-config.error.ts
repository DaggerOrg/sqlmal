/** sqlmal.json is missing, malformed or incomplete. */
export class ProjectConfigError extends Error {
  override readonly name = 'ProjectConfigError';
}
