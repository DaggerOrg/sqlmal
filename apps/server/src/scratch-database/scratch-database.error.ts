/** A scratch database could not be created, or its server could not be derived. */
export class ScratchDatabaseError extends Error {
  override readonly name = 'ScratchDatabaseError';
}
