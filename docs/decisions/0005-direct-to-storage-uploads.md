# ADR-0005: Direct-to-object-storage multipart uploads

Status: Accepted — 2026-09-23

## Decision

All uploads use S3 multipart with presigned part URLs (a small file is a
single part). The browser uploads parts with XHR for progress, retries failed
parts, and aborts the multipart upload on cancel. The API only signs URLs,
verifies the final object size, and enqueues processing. This works with AWS
S3, MinIO, and GCS (XML API interoperability with HMAC keys).

## Consequences

No file bytes pass through the API process; uploads are resumable at part
granularity within an upload session. The bucket needs CORS allowing `PUT`
from the web origin and exposing the `ETag` header.
