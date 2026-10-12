# Deploying the playground

## Deploy equals merge to main

The live site is https://lkopietz3-byte.github.io/honesty-kits/. It is built and published by `.github/workflows/pages.yml` on every push to `main` (and on a manual run of that workflow). There is no other deploy path. Treat a merge to `main` as a deploy, and do not do it until Lucas says "deploy" in chat.

## What is tested before it ships

`pages.yml` runs, in order, on Node 24 with SHA-pinned actions and minimal permissions:

1. `npm ci --no-audit` installs the exact kit versions from the lockfile.
2. `npm audit signatures` checks npm's registry signatures (and provenance attestations where a package has them).
3. `npm test` runs every example and every generated snippet against the real kits, checks the build output (kit files at the tested version, a complete import graph, local fonts, a Content-Security-Policy that allows no third-party requests), and runs the claims test.
4. `node tools/build.mjs` writes `dist/`, which is uploaded and deployed.

`ci.yml` runs the tests and the build on pull requests and on pushes to `main`. A pull request is never deployed.

What is not tested in CI: how the page looks and behaves in a real browser (layout at phone and desktop widths, focus, contrast). `node tools/rendered-check.mjs` does that locally when Playwright is available; see the comments at the top of the file. Whether CI is currently green is not recorded here. Look at the run.

## Prove the live site equals the tested revision

A green run, a stale preview and an `npm test` on your laptop are not proof that the live site is the revision you tested. After a deploy:

1. Note the merge commit and its time (`git log -1 --format='%H %cI' origin/main`).
2. Check the live response is fresh: `curl -sI https://lkopietz3-byte.github.io/honesty-kits/` should show `HTTP/2 200` and a `last-modified` time just after the workflow finished. A matching time is consistent with the deploy but does not prove it.
3. Compare content. Build that exact commit and compare file hashes with what the site serves:

```bash
git checkout <merge commit> && npm ci && node tools/build.mjs
v=$(node -p "require('./package.json').devDependencies['grounding-kit']")   # the pinned version, whatever it is today
for f in index.html app.mjs demos.mjs viz.mjs sitemap.xml kits/grounding-kit@$v/index.js; do
  a=$(shasum -a 256 dist/$f | cut -d' ' -f1)
  b=$(curl -s "https://lkopietz3-byte.github.io/honesty-kits/$f" | shasum -a 256 | cut -d' ' -f1)
  [ "$a" = "$b" ] && echo "same  $f" || echo "DIFF  $f"
done
```

Every line should say `same`. The build is deterministic, so the same commit gives the same bytes. Report this as production verified only when you ran it after the deploy; otherwise say NOT_RUN.

## HOLD list

Until Lucas says go in chat, none of these happen, from any branch or by any agent:

- `git push` of any branch, and any merge to `main`
- tags and releases, in this repo or any kit repo
- `npm publish`, `npm login`, and trusted-publishing runs
- Show HN posts, MCP directory submissions, and any other post, message or outreach
- license changes: the README license line, `LICENSE`, the `license` field in any kit's `package.json`, the JSON-LD license URL in `tools/build.mjs`, the honesty-mcp registry entry
- DNS or domain changes, accounts, payment links, and new analytics

Preparing work on a local branch, running tests, and writing docs are fine.

## Rolling back

Reverting a bad deploy means a new merge to `main` (or re-running `pages.yml` on a known-good commit), which is another deploy and needs the same go. If a workflow run fails before the deploy step, the previous site stays live.
