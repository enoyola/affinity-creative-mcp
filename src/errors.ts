export class McpFailure extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "McpFailure";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof McpFailure) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }

  return { code: "INTERNAL_ERROR", message: String(error) };
}
