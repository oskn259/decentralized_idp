/** A `/token` refusal, with its RFC 6749 / RFC 9449 error code. */
export class OAuthError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_client" | "invalid_grant" | "invalid_dpop_proof",
    message: string
  ) {
    super(message);
  }
}
