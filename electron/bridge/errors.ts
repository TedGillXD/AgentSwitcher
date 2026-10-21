export class BridgeRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
