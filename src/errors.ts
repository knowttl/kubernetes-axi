export class Failure extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 1, readonly details: { upstreamStatus?: number; cause?: string } = {}) {
    super(message);
  }
}
