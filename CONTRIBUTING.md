# Contributing to zearch-mcp

Thanks for helping. The org-wide guide is at [zearchcomputer/.github](https://github.com/zearchcomputer/.github/blob/main/CONTRIBUTING.md); this page covers what's specific to the MCP server.

- **Small and dependency-light.** Runtime dependencies are the MCP SDK and Zod. The answer view is one HTML file with no framework and no network access. Add a dependency only with a clear reason in the PR.
- **Tools are a public interface.** Renaming a tool, removing an input or changing an output field breaks people's setups. Add, don't change; call out anything breaking in the PR.
- **Copy.** Tool descriptions and messages are read by models and people. Say what Zearch does and what it checked, plainly. No hype words. See [BRAND_MESSAGING](https://github.com/zearchcomputer/zearch/blob/main/docs/BRAND_MESSAGING.md).
- **No real API calls in tests.** `test/mock-api.mjs` stands in for the Zearch API; extend it rather than calling the network.
- **Never log keys** or put them in errors, test fixtures or issues.

```sh
npm ci
npm test            # build + all tests
npm run typecheck
```

To try a change in a client, build and point the client at `node /path/to/zearch-mcp/dist/index.js` with `ZEARCH_API_KEY` set.

Work on a branch and open a pull request; a maintainer reviews and merges.
