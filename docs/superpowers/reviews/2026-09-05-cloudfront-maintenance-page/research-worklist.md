# Build research worklist

Date: 2026-09-07
Branch: `codex/cloudfront-maintenance-page`

Phase 1 independently mapped the approved S1 static page, S2 Terraform, and S3 browser/API surfaces against the live branch. The detailed source reference is intentionally ignored run state under `.superpowers/sdd/phase1-worklist.md`; this tracked record preserves the implementation decisions.

The live tree matches the approved spec and plan. S1 owns a standalone five-key edge catalog, actual Terraform template, and offline Terraform renderer. It must not widen the outbound SMS/voice/email message catalog. S2 adds the private, exact-object S3/OAC origin without changing app, media, dynamic-route, default-route, or deploy-health contracts; its local proof must test exactly 502/504 status-preserving mappings and all six fault probes. S3 retains the existing API client's non-JSON `ApiError` behavior and the typed 503 readers, and it uses the actual S1 renderer in a hermetic browser route fulfillment with the shared overflow helper.

No blocking drift, hidden importer, or additional product decision was found. S1 is the first sequential build slice; S2 then consumes its JSON/template directly, and S3 imports its renderer only for test-owned browser proof.
