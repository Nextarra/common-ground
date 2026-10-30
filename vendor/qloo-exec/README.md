# Qloo exec-only source slice

These ten JavaScript files are byte-for-byte copies of selected `dist/` files from the official MIT-licensed `@qloo/qloo-harness@0.1.26` npm release. LICENSE and THIRD_PARTY_NOTICES.md are also retained unchanged. UPSTREAM.json records each path, size, SHA-256 and upstream tarball integrity. `evidence/upstream-verification.json` records comparison against a fresh pinned npm tarball, including its SHA-512 integrity.

This is a derived app component, **not an untouched official CLI distribution or an officially endorsed fork**. The local wrapper is ../../qloo-exec.mjs; its application transport/schema boundaries are ../../qloo-runtime.mjs. The vendor files themselves are unchanged. Run `node qloo-exec.mjs --help` for upstream exec workflow help. The local wrapper permits recommend/rank only.

The selected static import closure uses only these local files, Node built-ins, typebox and typebox/value. The broader package's updater, model runtime, Pi, glob/minimatch/brace-expansion and npm Undici are not included or installed. The retained upstream notices describe the full package and are intentionally not rewritten to hide provenance; their references to excluded components do not indicate those components are present here.

The copied official client preserves upstream `/search`, `/entities` and `/v2/insights` request construction, API-key header and workflow result normalization. The application wrapper adds strict raw response checks, no automatic redirects, fixed initial origin/paths, one HTTP attempt, smaller response limit, no home config/custom resolver/logging and bounded child cancellation. These are local policy choices, not claims about the official distribution.

A deliberate update requires choosing an official release, repeating its import-closure review, copying licensed files exactly, regenerating the manifest from a pristine tarball, rerunning contract/security/browser tests and documenting any changed behavior. Do not edit a vendor file merely to bypass a failing test; place app policy in the wrapper when possible.
