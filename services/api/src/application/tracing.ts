/**
 * Correlation and causation IDs: up to 128 letters, digits, or `_ . : -`.
 * The HTTP `X-Correlation-Id` header and outbox events share this rule.
 */
export const traceIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isTraceId(value: string): boolean {
  return traceIdPattern.test(value);
}
