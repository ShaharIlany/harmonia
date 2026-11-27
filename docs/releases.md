# Releases

Every version tag is a release, built on GitHub
([.github/workflows/release.yml](../.github/workflows/release.yml), on an Apple
Silicon runner), and every push to `main` gets a version tag: the next patch
after the newest one (v2.1.1, then v2.1.2), from
[.github/workflows/tag.yml](../.github/workflows/tag.yml).

For a minor or major version, tag the commit yourself and push it with the
commit. A commit that already has a version tag gets no other, and the patches
after it count up from it:

```bash
git tag v2.2.0 && git push --atomic origin main v2.2.0
```

To push to `main` without a release, put `[skip ci]` in the commit message.

The release builds the app with `build.sh` and publishes `Harmonia-arm64.zip`
(about 20 MB) with its `.sha256`, and the same app as `Team-Chat-arm64.zip`:
installs from before the rename look for that name.
