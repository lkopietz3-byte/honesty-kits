# Agent rules for honesty-kits

This repository is the front door for the honesty kits: a static playground (GitHub Pages) plus the tests that keep it honest. It is in a hardening-only state. Do not add features unless Lucas asks in chat.

## Hold: nothing outward-facing without a go

Nothing outward-facing (send, post, publish, outreach, payment links, licensing, deploy) happens until Lucas says go in chat. That includes `git push`, merging to `main` (which deploys the live site), tags, `npm publish`, `npm login`, trusted-publishing runs, directory or Show HN submissions, license text changes in this repo or any kit repo, and any message to anyone. Prepare the work on a branch and stop. The full list is in `DEPLOY.md`.

Pushing a branch needs his OK too. Merging to `main` needs a separate, explicit "deploy".

## Private branch

`local-history` is a local-only branch with private history. Never push it, merge it, or check it out into another branch. Work from `origin/main` on a new branch, preferably in a git worktree.

## The loop

```bash
npm ci          # installs the exact kit versions the page serves (a stale node_modules makes the build test fail)
npm test        # every example and generated snippet against the real kits, the build, and the claims test
node tools/build.mjs && npm run serve    # http://127.0.0.1:8080/
```

`node tools/rendered-check.mjs --playwright-root <dir> --axe <axe.min.js or folder>` loads the built page in a real browser (widths, dark mode, requests to other origins, focus, axe). It needs Playwright and axe-core by path and adds no dependency; without them it prints NOT_RUN and exits 3 (also when only axe-core is missing, even if everything else passed). CI does not run it.

CI uses Node 24. Run `npm ci` again after switching branches or pulling, before trusting any test result.

To move pinned kit versions, use `node tools/bump-kits.mjs <kit>@<version> ...`. It edits `demos.mjs`, `package.json` and the lockfile together, then checks npm's signatures. Do not edit those three by hand. Bumping a version here does not publish anything, but it changes what the live site serves once merged, so it follows the hold above.

## The claims-test rule

`test/claims.test.mjs` derives every public count from the source (`KITS` in `demos.mjs`, the example presets, the installed kit packages, and the honesty-mcp source when it is on disk) and fails when the README, the page or the generated metadata drift from it.

- Never hard-code a count in the test. Change the source or the copy so they agree.
- Put a new number in public copy only if the test can place it; an unplaced count fails on purpose.
- If honesty-mcp lives somewhere other than `../honesty-mcp` or `~/honesty-mcp`, set `HONESTY_MCP_DIR`. When its source is absent those checks are skipped, and a skip is NOT_RUN, not a pass.

## Honest copy

- Plain, specific, American spelling. No em dashes.
- Say "12 kits plus honesty-mcp" or "13 packages". Never a bare "13 kits" or "12 packages". Derive the numbers from `KITS`.
- Do not claim that all packages are published with provenance. Check the registry before saying anything about provenance.
- No certification, fraud-detection, "verified" or "catches fake reviews" claims the code does not back.
- No invented numbers, prices, quotes or testimonials.

## Evidence labels

Label claims Verified (you ran or read it), Reported (someone else's word), Inferred or Unknown. Keep implemented, locally verified, production verified and outcome validated separate. A green `npm test` is local verification, not proof that the live site matches. A check you skipped is NOT_RUN. Do not call CI green unless you looked at the run.

## Other rules

- One writer per branch. Commit logical groups with explicit paths (never `git add -A`) and check `git show --stat` after each commit.
- Never print, log or commit secrets or tokens.
- The kits and this site run locally in the browser. Do not add analytics, tracking, third-party scripts or fonts; the page's Content-Security-Policy and the build test enforce this.
- Anything bigger than the task in front of you goes in the report as a follow-up, not into code.
