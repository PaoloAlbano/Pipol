# Releases and versions

The whole repository has **one version**: the web app, the relay and the auth server are released together, and a version is a tag like `v0.3.0` on `main`. They are deployed separately (the app on Cloudflare Pages, the relay and the auth server wherever you host them), but they evolve together, so one number says which code a deployment is made of.

The version is **the tag, not a number written in the code**: nothing is committed to make a release, so there is no release pull request and nothing to merge. The `version` in the `package.json` files is the placeholder `0.0.0-development` on purpose.

While the version starts with `0.`, the protocol between the app and the relay can still change: see [Compatibility](#compatibility).

## What a version means

[Semantic Versioning](https://semver.org), decided from the commit messages (the title of a squashed pull request is the commit message, so it has to start with the type):

| Commit | Raises | Example |
|--------|--------|---------|
| `fix: …`, `perf: …`, `revert: …` | the last number (patch) | `0.2.0` → `0.2.1` |
| `feat: …` | the middle number (minor) | `0.2.1` → `0.3.0` |
| `feat!: …` or a `BREAKING CHANGE:` line in the body | before `1.0.0`, the middle number; from `1.0.0` on, the first (major) | `0.3.0` → `0.4.0`, `1.2.0` → `2.0.0` |
| `docs:`, `test:`, `ci:`, `chore:`, `refactor:` | nothing: no version | |

When a merge brings several commits, the biggest change decides. A merge made only of `docs:`, `test:`, `ci:`, `chore:` or `refactor:` makes no version: nothing changed for the users. If a small change should be a version, call it `fix:`.

## How a release is made

Nothing to do. When the CI workflow (the tests) has finished on a merge to `main`, and **only if it passed**, the [Release workflow](../.github/workflows/release.yml):

1. looks at the commits since the last tag (`scripts/next-version.mjs`, with the rules above);
2. if they make a version, creates the tag `vx.y.z` on the commit that was tested and a GitHub release whose notes list the changes by type, with the pull request each came from;
3. builds and publishes the three Docker images of that version.

A merge whose tests fail is not released, and the next one that passes releases the commits of both. The releases page of the repository is the changelog. Two merges close together are released one after the other, each from the tag of the previous.

The branch rule that requires the check `test` before a merge already keeps broken code out of `main`; waiting for the tests on the merge itself covers the rest.

To see what the next release would be, without making it:

```bash
node scripts/next-version.mjs
```

The first release starts from the last tag that exists (`v0.1.0`), so its notes list everything since then. To start from another point, tag the commit by hand (`git tag v0.2.0 <commit>` and push it) before the first merge.

## Docker images

Each release publishes three images on the GitHub container registry, each with the tags `x.y.z`, `x.y` and `latest`:

| Image | Built from |
|-------|-----------|
| `ghcr.io/paoloalbano/pipol-web` | [`Dockerfile`](../Dockerfile) |
| `ghcr.io/paoloalbano/pipol-relay` | [`relay/Dockerfile`](../relay/Dockerfile) |
| `ghcr.io/paoloalbano/pipol-auth` | [`auth/Dockerfile`](../auth/Dockerfile) |

On a server, point at a version (`pipol-relay:0.3.0`), not at `latest`, so that a restart does not change what runs. How to run them: [Running everything with Docker](docker.md).

The images are built with two arguments, `APP_VERSION` and `GIT_COMMIT`, which is how they know what they are. Building an image by hand without them is fine: it just does not say its version.

## Which version is running

What a deployment can say depends on how it was built:

| Where | What it says |
|-------|-------------|
| **The app on Cloudflare Pages**, built from git | *Settings*, at the bottom: only the commit (`abc1234`), since it is not a release build |
| **The relay and the auth server built from git** (for instance on Render) | `GET /version`: `{ "name": "…", "version": null, "commit": "abc1234" }`; the commit comes from `RENDER_GIT_COMMIT` (or `GIT_COMMIT`) |
| **The Docker images** | The app: `Pipol v0.3.0 · abc1234` in *Settings*; the servers: `{ "name": "…", "version": "0.3.0", "commit": "abc1234" }`. The version is also written in the log at start-up |

To know which release a commit belongs to, look at the releases page, or run `git describe --tags --contains <commit>`. To have the version everywhere, run the published images instead of building from git.

## Compatibility

- **A new app with an older relay keeps working**, and the other way round: changes to what the app and the relay say to each other are added, not changed. For example, the app now tells the relay when it leaves on purpose (`leave`), and a relay that does not know the message ignores it.
- A change that breaks this is written as `feat!:` and raises the version as described above, so it is in the release notes.
- Update the relay before the app when a release adds something the app relies on; the notes say so.

## What does not change

Cloudflare Pages still publishes the app on every push to `main`: the tag marks a version, it does not decide when the site is deployed.
