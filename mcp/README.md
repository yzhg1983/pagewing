# pi-aside-mcp

Lets a program on your computer, such as a [pi](https://github.com/earendil-works/pi) coding-agent session, use
pi-aside's page tools in your Chrome over MCP. Proof of concept; macOS and Linux.

How it works: the MCP client starts `pi-aside-mcp` over stdio. It reaches pi-aside through a native messaging host that
Chrome starts while Settings > Advanced > Local agents is on. Each agent session works in a Chrome tab group of its
own and reaches only the tabs in it. The tools do not ask you before acting; Off in Settings > Tools still applies.

## Try it

1. Register the native host with Chrome, once. For an unpacked pi-aside, pass its ID from `chrome://extensions`:

   ```sh
   node mcp/src/cli.ts install --extension-id <id>
   ```

   Restart Chrome.

2. In pi-aside: Settings > Advanced > Local agents > On. Chrome asks for native messaging and access to all sites.

3. Add the server to your MCP client, for example:

   ```sh
   pi mcp add pi-aside -- node /path/to/pi-aside/mcp/src/cli.ts
   ```

Tools: `open_tab`, `list_tabs`, `read_page`, `observe_page`, `act_on_page`, `run_script`, `screenshot_page`,
`close_tab`. Start with `open_tab`.

`node mcp/src/cli.ts uninstall` removes the registration.
