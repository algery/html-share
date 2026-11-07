# Chromium sandbox profile

`playwright-seccomp.json` is based on the Apache-2.0 Docker seccomp profile from
[Playwright v1.62.1](https://github.com/microsoft/playwright/blob/v1.62.1/utils/docker/seccomp_profile.json).
The profile additionally allows the browser's chroot syscall. Chromium uses it
inside its own user namespace to drop filesystem access. The container drops all
capabilities, runs without network access outside loopback and has no application
credentials. See [Chromium sandbox source](https://chromium.googlesource.com/chromium/src/sandbox/+/refs/heads/main/linux/services/credentials.cc)
and [the Playwright license](./LICENSE.playwright).
