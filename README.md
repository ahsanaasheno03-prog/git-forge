# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ahsanaasheno03-prog/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ahsanaasheno03-prog/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node.js process, with no UI and no dependencies: git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API under /api/v3 for repositories, contents, labels, issues and pull requests; the GraphQL v4 API at /api/graphql; and a Model Context Protocol endpoint at /mcp — all served from its own in-memory store. The git object model, packfile codec (with delta resolution), three-way tree merge and the GraphQL executor are implemented from scratch on the Node standard library alone; no git binary is used at runtime.

## Run it

```sh
node main.ts
```

---

Entered on [make.fun](https://make.fun/?ref=e7qsdyxs&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
