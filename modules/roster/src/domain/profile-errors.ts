export class ProfileImportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { unconfirmedProfiles?: string[] },
  ) {
    super(message);
    this.name = "ProfileImportError";
  }
}

export class ProfileDeleteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProfileDeleteError";
  }
}
