export class AppError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'AppError';
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  const message = error instanceof Error ? error.message : '';
  // Only pass known symbolic codes across IPC. OS/parser errors may contain credentials.
  return /^[A-Z][A-Z_]{3,60}$/.test(message) ? message : 'OPERATION_FAILED';
}
