/**
 * Error with a stable machine-readable code shared by the tool, service and
 * storage layers. Tool responses surface the code to the host AI.
 */
export class MemoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "MemoryError";
  }
}
