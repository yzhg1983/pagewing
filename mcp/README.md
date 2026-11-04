# pi-aside-mcp

Lets a coding agent on your computer, such as [pi](https://github.com/earendil-works/pi), use
[pi-aside](https://github.com/yzhg1983/pi-aside)'s page tools in your Chrome over MCP: open a page, read it, click and
type, run a script, take a screenshot. macOS and Linux.

## Set up

1. Install pi-aside in Chrome.
2. Add the server to your agent:

   ```sh
   pi mcp add pi-aside -- npx -y pi-aside-mcp
   ```

   Other MCP clients: add `npx -y pi-aside-mcp` as a stdio server.

3. In pi-aside's side panel: Settings > Advanced > Local agents > On. Chrome asks for native messaging and access to
   all sites.

The first call after setup may take up to 30 s while pi-aside connects.

## How it works

Chrome lets an extension talk only to programs registered with it (native messaging). At each start, `pi-aside-mcp`
registers a small helper in each installed Chromium browser: `~/.pi-aside/host.sh`, and a file in the browser's
`NativeMessagingHosts` folder that lets only pi-aside start it. While the switch is on, pi-aside starts the helper; the
helper relays your agent's calls to pi-aside over a socket only you can open (`~/.pi-aside/bridge.sock`).

```
agent ──MCP──▶ pi-aside-mcp ──socket──▶ helper ──native messaging──▶ pi-aside in Chrome
```

## What the agent can do

Tools: `open_tab`, `list_tabs`, `read_page`, `observe_page`, `act_on_page`, `run_script`, `screenshot_page`,
`close_tab`. Each agent session works in a Chrome tab group of its own, named after the agent, and reaches only the
tabs in it. The tools do not ask you before acting; Off in Settings > Tools still applies, and turning the switch off
ends every session.

## Commands

- `pi-aside-mcp`: the MCP server (stdio).
- `pi-aside-mcp install --extension-id <id>`: also allow an unpacked pi-aside, by its ID from `chrome://extensions`.
- `pi-aside-mcp uninstall`: remove the registration.

## Develop

From the repo root: `node mcp/src/cli.ts` runs the server from source, `npm run build:mcp` builds `mcp/dist/cli.js`
for the package, and `npm run test:local-agents` runs the Chrome end-to-end test.
