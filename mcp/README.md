# pagewing-mcp

Lets a coding agent on your computer, such as [pi](https://github.com/earendil-works/pi), use
[Pagewing](https://github.com/yzhg1983/pagewing)'s page tools in your Chrome over MCP: open a page, read it, click,
type, hover, and drag, run a script, take a screenshot. macOS and Linux. Needs the Pagewing Chrome extension, 0.4.3 or later.

## Set up

1. Install Pagewing from the [Chrome Web Store](https://chromewebstore.google.com/detail/pagewing/eamkpenaglckggljpkdljhillecgpjlp).
2. Add the server to your agent:

   ```sh
   pi mcp add pagewing -- npx -y pagewing-mcp
   ```

   Other MCP clients: add `npx -y pagewing-mcp` as a stdio server.

3. In Pagewing's side panel: Settings > Advanced > Local agents > On. Chrome asks for native messaging, network
   requests, and access to all sites. If you turned the switch on before Pagewing asked for network requests, click
   Allow in the Local agents section.

The first call after setup may take up to 30 s while Pagewing connects.

## How it works

Chrome lets an extension talk only to programs registered with it (native messaging). At each start, `pagewing-mcp`
registers a small helper in each installed Chromium browser: `~/.pagewing/host.sh`, and a file in the browser's
`NativeMessagingHosts` folder that lets only Pagewing start it. While the switch is on, Pagewing starts the helper; the
helper relays your agent's calls to Pagewing over a socket only you can open (`~/.pagewing/bridge.sock`).

```
agent ──MCP──▶ pagewing-mcp ──socket──▶ helper ──native messaging──▶ Pagewing in Chrome
```

## What the agent can do

Tools: `open_tab`, `list_tabs`, `read_page`, `observe_page`, `act_on_page`, `run_script`, `screenshot_page`,
`read_console_messages`, `read_network_requests`, `close_tab`. The console and network tools record a tab from the
session's first use of it; a page that `open_tab` or `navigate` loads is recorded from its start. Each agent session works in a Chrome tab group of its own, named after the agent, and reaches only the
tabs in it. Tabs you open from an agent's tab, or drag into its group, join it, and the agent can use them. The tools
never ask you before acting: Ask in Settings > Tools counts as On for agents, scripts included, and only Off stops a
tool. Turning the switch off ends every session.

## Commands

- `pagewing-mcp`: the MCP server (stdio).
- `pagewing-mcp install --extension-id <id>`: also allow an unpacked Pagewing, by its ID from `chrome://extensions`.
- `pagewing-mcp uninstall`: remove the registration.

## Develop

From the repo root: `node mcp/src/cli.ts` runs the server from source, `npm run build:mcp` builds `mcp/dist/cli.js`
for the package, and `npm run test:local-agents` runs the Chrome end-to-end test.
