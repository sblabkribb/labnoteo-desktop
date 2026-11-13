# SignPath Foundation onboarding

## Current stage

Application submitted on 2026-11-13; the website confirmed "Form submitted".
Foundation review is pending. No acceptance, certificate, token, or successful signed
build is implied. The normal release workflow remains unchanged until a production
signing rehearsal passes. Do not replace the existing Tauri updater key.

## Application information

- Project: **labnoteO Desktop**
- Source/homepage: https://github.com/sblabkribb/labnoteo-desktop
- Downloads: https://github.com/sblabkribb/labnoteo-desktop/releases
- License: Apache-2.0; core submodule is also Apache-2.0. A complete dependency/license
  review is still required; those two licenses alone do not establish eligibility.
- Category: Science
- Build system: GitHub Actions
- Tagline: An open-source Windows application for biology and bioinformatics lab
  notebooks stored as local Markdown files.
- Description: labnoteO Desktop helps biology and bioinformatics researchers organize
  experiments, workflows, samples, and protocols in local Markdown files. It provides
  a desktop editor, search, structured experiment records, and optional connections
  to services chosen by the user. Windows installers are built from source using
  GitHub Actions.
- Reputation: an early-stage project, with 6 Desktop GitHub stars when checked on
  2026-11-13. Cite the public source/commit history, release download counts, Actions
  logs, README demonstrations, and related https://github.com/sblabkribb/labnoteo.
  Do not claim widespread adoption or institutional endorsement without evidence.
- Contact: Yesung Park, Korea Biofoundry. The maintainer provided the account email
  directly for the application; it is not stored in this repository.
- Designated signing approver: [ParkYaeseong](https://github.com/ParkYaeseong).
  SignPath role assignment and MFA verification remain pending.
- Discovery source: AI assistant / ChatGPT, with official SignPath documentation.

Publish the code signing and privacy policy links before submitting the application
at https://signpath.org/apply.html. Keep the onboarding status accurate until accepted.
The applicant must review the Foundation terms and personal-data consent at submission.
Marketing consent is optional and is not required for this application.

## Sample build

`signpath-onboarding.yml` builds unsigned samples from the checked-out source and
uploads an Actions artifact for onboarding. It never publishes a Release, needs no
signing secrets, and does not produce updater signatures. The artifact contains the
app EXE, NSIS installer, source commit/run identity, hashes, and Windows file metadata.
Use this to agree artifact paths and metadata restrictions with SignPath.

## After acceptance

1. Confirm named authors/reviewers/approvers and enable MFA. Complete the dependency
   review and any Foundation-requested changes. Configure GitHub trusted-build origin.
2. Configure narrowly scoped app-EXE and installer artifact configurations in SignPath.
   Match actual `ProductName` and version metadata from the sample, not guessed values.
   Do not assume SignPath can unpack and re-sign NSIS contents: the documented generic
   PE format does not provide nested NSIS signing.
3. Store the submitter token as `SIGNPATH_API_TOKEN` in GitHub Actions secrets; store
   organization ID, project slug, policy slug, and artifact configuration slugs as
   repository variables. A submitter token must not approve production requests.
4. Rehearse a two-stage build on a new version: `tauri build --no-bundle
   --no-binary-patching`, upload app EXE to Actions, submit the artifact ID through the
   official SignPath action, wait for human approval, and restore the signed app EXE.
5. Package with `tauri bundle --bundles nsis --no-sign --no-binary-patching` so Tauri
   does not patch and invalidate the app signature. Check the app signature again
   after packaging. Upload the installer to Actions and sign it in a second request.
   Confirm with SignPath whether their approved pipeline policy accepts this two-stage
   build and how many approvals are required.
6. Verify both app and installer with Authenticode chain validation and a timestamp;
   reject test certificates for public releases. Only then create the installer `.sig`
   using the existing Tauri key and regenerate `latest.json` for that exact file.
7. Integrate the verified stages into `release.yml`, retaining its tag/version/key
   checks and draft-until-complete publication. Include `actions: read` for the signing
   action and the reusable caller in `sync-core.yml`. A signing failure, timeout, or
   rejection must never fall back to unsigned publication.
8. Test a fresh install and an update from the existing public version. Publish a new
   version; do not overwrite existing release assets. Update the public policy status
   and release description only once production signing actually succeeds.

Foundation signing requires manual release approval, so the current unattended core
release chain will gain an approval wait. Daily retries should not create unlimited
duplicate signing requests; agree retry/resume behavior before enabling production.

## Official references

- https://signpath.org/terms.html
- https://docs.signpath.io/trusted-build-systems/github
- https://docs.signpath.io/artifact-configuration/reference
- https://v2.tauri.app/distribute/sign/windows/
