/**
 * The `Content-Disposition` of a receipt download: `inline`, an ASCII
 * fallback name, and the RFC 5987 UTF-8 name. The local API and presigned S3
 * downloads use the same value.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
