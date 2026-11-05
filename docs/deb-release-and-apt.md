# Debian releases and the planned signed APT repository

## Current packaging and CI

`just deb` builds the installed `app.asar` and bundled daemon. There is no writable
application overlay, baseline extraction, or component updater. dpkg owns program
files. Local build output is in `release/`.

`.github/workflows/linux-deb.yml` runs on main pushes or manual dispatch. Backend,
SDK and mutil-ai revisions are pinned in `build/repositories.json`; update these
pins when intentionally integrating new source. The SDK manifest must name the
same clean backend revision. Each release includes a deb, SHA256SUMS and the four
source commit IDs in build-provenance.json.

## Version allocation

The package name remains `qaqh-electron`, architecture `amd64`. Its actual Debian
Version is `3.0.YYYYMMDD-N`, with the date taken in Asia/Shanghai:

```
3.0.20261105-1 < 3.0.20261105-2 < 3.0.20261105-10 < 3.0.20261106-1
```

CI serializes release jobs, scans releases including reserved drafts, and reserves
the next number as a draft before building. Failed builds consume their revision;
reruns allocate a new one. Do not delete reserved drafts or replace a published
version's assets. GitHub concurrency can supersede an older pending run; it does
not interrupt the active release.

Local builds use `.tmp/deb-version.json` as their allocation ledger. They increment
on the same date and start at 1 on the next date. The source manifest is a minimum
version. An explicit `QAQH_BUILD_VERSION` overrides local allocation; its date is
derived unless QAQH_BUILD_DATE is supplied. Local numbers are not globally
coordinated with CI: distribute official packages only through CI. After testing a
locally newer build, the next official version must exceed it for APT to upgrade.

electron-builder normally maps semver `-N` to Debian `~N`. The build supplies the
raw Debian version to FPM and checks `dpkg-deb --field ... Version` before accepting
an artifact. A same-version rebuild is not an APT update, regardless of file hash.

## Selected distribution: signed binary APT repository on GitHub Pages

Use a dedicated repository, for example `qaqtam/qaqh-apt`, serving
`https://qaqtam.github.io/qaqh-apt/`. This is a proposed location, not an already
created repository or active URL. Launchpad PPA accepts source uploads for Ubuntu
builders; our existing prebuilt Electron deb fits a binary APT repository directly.

The repository needs this structure (generated with aptly or reprepro):

```
pool/main/q/qaqh-electron/qaqh-electron_3.0.YYYYMMDD-N_amd64.deb
dists/stable/main/binary-amd64/Packages.gz
dists/stable/Release
dists/stable/InRelease
qaqh-archive-keyring.asc
```

The follow-up publishing job should:

1. Consume a successfully verified release and its checksum; never rebuild it.
2. Check package name, architecture and increasing Debian Version.
3. Add the deb and regenerate Packages and Release with SHA256 checksums.
4. Sign Release to InRelease with a dedicated archive signing key, then deploy one
   complete snapshot to Pages. Keep a previous snapshot for recovery.
5. Publish the public key and fingerprint through the project documentation.

Keep the private signing key and passphrase in GitHub Actions secrets, with the
public key committed. Use a dedicated Pages environment and one serialized
publisher. Do not add any signing secrets to the Electron bundle. Pages setup,
archive creation and key generation are separate deployment work; this change
does not create or publish the APT repository.

After the real repository and key are published, install the verified public key
at `/etc/apt/keyrings/qaqh.asc` and create `/etc/apt/sources.list.d/qaqh.sources`:

```
Types: deb
URIs: https://qaqtam.github.io/qaqh-apt/
Suites: stable
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/qaqh.asc
```

Then `sudo apt update && sudo apt install qaqh-electron`. Later higher versions
appear through `apt update` and install through `apt upgrade`. Automatic background
installation additionally needs the user's unattended-upgrades policy to allow
this archive; adding a source alone does not enable that policy.

A local repository can instead use `URIs: file:/srv/qaqh-apt`; it still needs the
same metadata and signature. A directory containing only deb files is not an APT
repository. Different Ubuntu/Debian releases can share an archive only when their
runtime libraries satisfy the package dependencies. CI currently builds amd64 on
Ubuntu 22.04; this is not a claim of validation on every Debian/Ubuntu release.

References:

- [Debian version format and ordering](https://www.debian.org/doc/debian-policy/ch-controlfields.html#version)
- [Launchpad source package builds](https://ubuntu.com/docs/launchpad/user/how-to/packaging/build-deb-packages-in-launchpad/)
- [APT source configuration and file URIs](https://manpages.debian.org/trixie/apt/sources.list.5.en.html)
- [APT archive signing](https://manpages.debian.org/trixie/apt/apt-secure.8.en.html)
