# Validation

Prepared October 19, 2026.

The reviewed example passed a clean dependency install, TypeScript checking, 19 tests, its
generator, and two byte-identical demo runs matching docs/demo-output.md on Node 22.23.3,
pnpm 11.19.0, and PostgreSQL 16.14. The overview SVG and its PNG rendering were visually inspected against the README. These are synthetic examples, not production-scale or live-model tests.

The files were exported into fresh standalone Git history. Three independent agent reviews
checked identifiers, confidential narratives, and provenance. Company-specific operational
observations were removed. Secret and identifier scans found no private records or credentials;
the private identifier list and development histories are not included. Copyright attribution is
Geoffrey Lew, with all rights reserved, at his request. These checks do not establish ownership,
non-copying, or permission to publish.

Run pnpm typecheck and pnpm test from this directory after installing the locked dependencies.
CI in .github/workflows/ci.yml uses Node 22 and PostgreSQL 16, and additionally compares repeated
demo output against docs/demo-output.md. To scan locally, install Gitleaks and run:

```sh
gitleaks dir . --redact
gitleaks git . --redact
```

GitHub Actions results are available in the repository's Actions tab after push.
