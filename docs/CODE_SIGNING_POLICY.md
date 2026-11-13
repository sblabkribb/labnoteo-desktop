# Code signing policy

## Status

SignPath Foundation onboarding is being prepared. The project has not yet received
production signing access. Existing GitHub Release installers are unsigned; their
`.sig` files authenticate Tauri updates, not the Windows publisher.

The intended service, subject to acceptance, is:

> Free code signing provided by [SignPath.io](https://signpath.io), certificate by
> [SignPath Foundation](https://signpath.org).

This attribution describes the planned arrangement, not an already-issued certificate.
After approval and a successful signed release, maintainers must update this status
and the download/release page to identify the first signed version.

## Responsibilities

- Authors and reviewers: maintainers with write access to
  [sblabkribb/labnoteo-desktop](https://github.com/sblabkribb/labnoteo-desktop).
- Signing approvers: repository administrators designated in SignPath. The actual
  approver account must be confirmed and listed here before production activation.
- The GitHub Actions identity may submit signing requests; it must not approve them.

Participants must enable MFA for GitHub and SignPath before receiving signing access.
Each production signing request requires a human approval. Review covers the source
commit, workflow, dependencies, product metadata, and build origin.

## Scope

Only labnoteO Desktop executables and installers built from this repository are
eligible. Third-party binaries must not be signed as labnoteO's own code. Restrict
artifact paths and product/version metadata in SignPath; a filename alone is not
sufficient. Keep build provenance tied to the exact GitHub Actions run and commit.

For the NSIS distribution, sign the app executable before packaging, then sign the
installer. Preserve the app's signature during packaging. Generate the Tauri updater
signature only after the installer has its final Authenticode signature. Verify both
executables and the final updater assets before publishing. A rejected, expired, or
failed request must leave the release unpublished, with no unsigned fallback.

## Privacy and reports

See the [privacy policy](PRIVACY.md), including automatic update traffic and optional
external integrations. Do not send research data, credentials, vaults, or local settings
to the signing service; signing inputs are public-release build artifacts only.

Report suspected tampering through the repository's GitHub security reporting feature
when available. For a suspected misuse of a SignPath Foundation signature, follow the
reporting instructions in the [Foundation terms](https://signpath.org/terms.html).

## References

- [SignPath Foundation conditions](https://signpath.org/terms.html)
- [GitHub build integration](https://docs.signpath.io/trusted-build-systems/github)
- [Onboarding and release migration](SIGNPATH.md)
