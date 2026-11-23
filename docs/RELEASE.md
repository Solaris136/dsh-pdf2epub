# Releasing dsh-pdf2epub

The npm package is published by `.github/workflows/publish.yml` **when a GitHub
Release is published**. Nothing is published from a laptop, and no npm token is
stored in the repository: the workflow authenticates to npm through
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) and
attaches a provenance attestation.

## The one-time npm side

The package `dsh-pdf2epub` already exists on npm (owner `solaris011`), so the
trusted publisher is the only registration needed:

```sh
npm trust github dsh-pdf2epub \
  --file publish.yml \
  --repo Solaris136/dsh-pdf2epub \
  --allow-publish --allow-stage-publish \
  --yes
```

Check it with `npm trust list dsh-pdf2epub`. The same relationship can be created
in the npm web UI under the package's **Settings → Trusted publishing**; the four
fields are the repository (`Solaris136/dsh-pdf2epub`), the workflow filename
(`publish.yml`), an optional environment (unused here), and the allowed actions
(`npm publish` must be allowed for a Release to go live directly; `npm stage
publish` is always allowed).

npm does not validate the registration when it is saved. A mismatch - the wrong
repository, the wrong filename - only shows up as a failed publish.

## Releasing a version

1. Land the version bump on `main` through a pull request: `package.json` and
   `package-lock.json` move together, and CI must be green. The release workflow
   refuses a tag whose version does not match `package.json`, and refuses a tag
   whose commit is not on `main`.
2. Publish a GitHub Release whose tag is `v` + the version, for example `v0.0.1`.
   `gh release create v0.0.1 --generate-notes` creates the tag on `main` and the
   Release in one step.
3. The **Publish to npm** workflow checks out the tag, installs the locked
   dependencies, runs `npm run check`, and only then runs
   `npm publish --provenance --access public`.

A published version is permanent: the same version number cannot be published
again. If a run fails before the publish step, fix the cause and re-run the job;
if it fails at the publish step because the version already exists, the fix is a
new version, not a re-run.

## Re-running or recovering

- `gh run list --workflow publish.yml` shows the runs;
  `gh workflow run publish.yml -f tag=v0.0.1` re-runs one by tag.
- To publish by hand for an emergency, a maintainer can run `npm publish` from a
  clean checkout of the tag. That path has no provenance statement, so prefer
  the workflow.
- Trusted publishing can be restricted to staged releases only
  (`--allow-stage-publish` without `--allow-publish`). In that mode the workflow
  must call `npm stage publish`, and a maintainer approves the exact tarball with
  `npm stage approve <stage-id>` (2FA). See
  [staged publishing](https://docs.npmjs.com/staged-publishing).

## Version history

| Version | Contents |
| --- | --- |
| `0.0.0` | Name reservation only. Published by hand, an empty package with a README saying so. |
| `0.0.1` | First release through this workflow: the plugin as it stands on `main`. |
