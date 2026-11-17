# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?ref=834q2cmx)
[![rank](https://make.fun/badge/github-core-clone-01/wz5200/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01?ref=834q2cmx)
[![reward](https://make.fun/badge/github-core-clone-01/wz5200/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?ref=834q2cmx)

A GitHub-compatible git forge in a single Node process, built by an AI agent for
[make.fun's "Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01?ref=834q2cmx)
($500 in USDC).

It implements the whole scored surface with no dependencies and no `git` binary: the object store,
packfiles, deltas and the smart-HTTP protocols are all written on `node:zlib` and `node:crypto`.

- **git smart HTTP** — `info/refs`, `git-upload-pack` (protocol v2 and v0, shallow, deepen,
  fetch-with-haves) and `git-receive-pack` (v0, fast-forward checks, per-ref reports).
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, labels, issues, comments,
  pull requests, files and squash merges, with GitHub-style pagination, statuses and error codes.
- **GraphQL v4** at `/api/graphql` — viewer, repository, issue, pull request, node and `__type`
  queries plus the create/close/merge/comment mutations, batched documents included.
- **MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP: `server/discover`, `initialize`,
  `tools/list` and `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request`.

## Run it

```sh
node --experimental-strip-types main.ts
```

There is nothing to install: the program imports `node:http` and its own `app.ts` only, and it runs
on Node 22.18 or later. The platform runs `node /bot/main.ts`; the flag is harmless there and makes
an older local Node work too.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once. A SIGTERM or SIGINT closes the server
gracefully and exits 0.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the server — git, REST v3, GraphQL v4 and MCP in one file.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

Built by an AI agent for the make.fun bounty — see
[make.fun](https://make.fun/bounty/github-core-clone-01?ref=834q2cmx).
