# Core Workbench Quickstart · 从零启动工作台

This guide is for **0.3.0-alpha.1 or the current source tree**. Stable npm **0.2.7 does not include `web serve` or production MCP**. For stable DSH/CLI usage, see the [DSH guide](../user_guide.md) or [standalone CLI](HEADLESS_CLI.md). Alpha contracts may change; existing roots are not migrated automatically.

## Start a new workspace · 新建工作区

Use Node.js ≥22. To install the prerelease in your project:

```bash
npm install @mokuyoaxis/dsh-iris@0.3.0-alpha.1
npx dsh-iris --help
```

The commands below use a source checkout: install its locked dependencies with `npm ci`, then run from the repository root. For the installed alpha package, replace `node bin/dsh-iris.js` with `npx dsh-iris`. Use `@alpha` instead of the exact version only when you intend to follow prereleases.

Choose a **new private directory under your home**, on a filesystem that supports hard links. On Termux/PRoot, keep it in the Linux home rather than Android shared storage. These commands create a new workspace; they do not migrate an old DSH or Flow root. If the paths already contain data, choose another location.

```bash
IRIS_PREVIEW="$HOME/.iris/preview"
mkdir -p "$IRIS_PREVIEW"

node bin/dsh-iris.js flow init --data-root "$IRIS_PREVIEW/core"
node bin/dsh-iris.js execution init --audio --data-root "$IRIS_PREVIEW/core"
node bin/dsh-iris.js config init --provider-config "$IRIS_PREVIEW/providers.json"

node bin/dsh-iris.js web serve \
  --data-root "$IRIS_PREVIEW/core" \
  --auth-store "$IRIS_PREVIEW/auth" \
  --provider-config "$IRIS_PREVIEW/providers.json" \
  --allow-provider-management --allow-execution --allow-selection \
  --connection-store "$IRIS_PREVIEW/connections" \
  --allow-connection-management --allow-mcp \
  --port 3182
```

`--audio` initializes a new v3 execution root, supporting images, speech and transcription. It does not enable a model, spend credits or migrate existing roots. The switches above explicitly enable:

| Switch | What it permits |
|---|---|
| `--allow-provider-management` | The workbench owner can edit media services, models and pools |
| `--allow-execution` | Local imports, Run creation and supported media execution |
| `--allow-selection` | Save an image selection for a completed Run |
| `--allow-connection-management` | The owner can create, update, revoke and delete MCP grants |
| `--allow-mcp` | Serve Streamable HTTP at `/mcp`; stdio uses a bridge to the same Core |

The service listens on `127.0.0.1`. Keep this command running. Ctrl+C stops this service normally; it does not start or restart DSH. Only one execution service may manage this root. For read-only use, omit the write switches and unneeded management options; see [the workbench reference](LOCAL_WEB.md).

## Sign in · 登录

Open the printed **`loginUrl` once to set your access password**. Afterwards, open the ordinary `origin` and use that password. Remembered devices survive refreshes and normal restarts; logging out lets you sign back in with the same password. A mobile browser does not need access to Termux files.

In another terminal, recover the address without restarting:

```bash
node bin/dsh-iris.js web login \
  --data-root "$HOME/.iris/preview/core" \
  --auth-store "$HOME/.iris/preview/auth"
```

Use `web password reset` with the same paths only when you intend to reset the password and revoke all browser sessions. It preserves works and MCP grants. See [login and recovery](WORKBENCH_LOGIN.md). The workspace password, a provider API key and an MCP connection credential are three separate credentials.

## Make the first work · 生成第一件作品

1. Open **模型服务 → 添加服务**. Select the documented protocol, enter a name, Base URL and API key, or explicitly choose no authentication if the service supports it. Save the connection.
2. Open **模型与用途**, read the saved service's model directory or enter an exact model ID, and explicitly check its intended use. Save again. Approving a new use can enable its automatic pool; check the save summary.
3. Under **功能模型池**, choose automatic selection, a manually ordered list, or disabled. A manual empty list stays empty. Automatic selection uses confirmed, eligible models in stable order; it is not cross-request round-robin.
4. Under **创作 → 生成图片**, choose an actual configured model, enter a prompt and click **开始生成**. This is the step that calls the provider and may cost money. Choose the completed result, then download it. **作品** keeps the Run and its related outputs.

Opening pages and refreshing the spectrum do not generate media. Reading a model directory or checking a connection only checks that interface; neither proves media generation works. Optional keepalive is off by default and lasts only for this service session. Full details: [providers, pools and health](PROVIDER_SETTINGS.md).

For ComfyUI, use an existing service and an explicitly imported **API-format workflow** with mapped prompt/output nodes. Check declared parameters and available LoRA choices, then save and choose that workflow. Iris does not install ComfyUI, invent a graph or discover GPU models by guessing. See [ComfyUI workflows](IMAGE_GENERATION.md#comfyui-入口).

The current Web/MCP media entries cover image generation/editing, speech and transcription. Video, music and vision retain their existing [CLI](HEADLESS_CLI.md) / DSH entries; configuring their uses here does not add a Web creation form.

## Connect an Agent · 连接客户端

1. Open **客户端 → 新建连接**. Give it any meaningful name. Choose media functions and, for image generation, the separate generation capability. Grant only the operations needed: **读取** for history; **导入与创建** and **执行流程** for new media; **停止等待** only when wanted.
2. Save, then select a client template under **接入配置**. Use **stdio** for a local client that can run the exported command, or **HTTP** when it supports Streamable HTTP. HTTP here is loopback-only too.
3. Generate the configuration and merge the Iris entry into the client's chosen MCP configuration. Preserve existing entries. Reconnect in that client, then refresh the workbench to inspect the actual handshake.
4. Optionally generate and download the **连接专属 Skill**, then explicitly install it in that client's supported Skills directory:

```bash
node bin/dsh-iris.js skills install \
  --bundle /absolute/path/to/iris-skill.json \
  --directory /absolute/path/to/client-skills
```

The downloaded Skill contains instructions for the effective tools, without the connection key. The exported MCP configuration is private and may contain a credential; do not commit or share it. The CLI-oriented `iris-core` Skill is a separate entry, intended for direct CLI use.

The client starts a stdio **bridge**, not a second Core writer. Both transports require this Core service to stay running. A saved connection is an authorization record; it does not install a client or mean that client is online. On the same machine, keeping the data root, authentication directory, connection directory, installed executable path and port stable preserves normal logins and exported configurations.

Hand the client this task after it sees the actual tools:

```text
Use only this Iris MCP connection. Read the actual configured image models,
then generate one pale-purple iris flower with an explicitly permitted model.
Keep the original request UUIDs and inspect the original receipt until complete.
Read back the resulting artifact. Report its Run ID, artifact ID and actual status.
If acceptance or the result is unknown, inspect it; do not submit again automatically.
```

For an Agent handling setup, use the [Agent quickstart](AGENT_CORE_QUICKSTART.md). Transport details, templates and errors are in [MCP](MCP.md).

## Optional plugins and recovery · 可选插件与恢复

The quickstart above uses built-in media capabilities. Optional plugins need an explicit startup selection. Follow [plugin startup](PLUGIN_STARTUP.md) to load the bundled [contact sheet](CONTACT_SHEET.md), choose its page/operation and then grant that exact business to a connection. Loading code, enabling a business and authorizing a client are separate choices. Plugins are trusted Node code, not a sandbox or a marketplace install.

Restart by stopping this service normally and repeating the same `web serve` command. Core keeps the original Run/Task/Operation and artifacts; restart does not automatically regenerate. After a forced exit, inspect the lease and its owner before any explicit recovery; never delete a lock to get past “busy”. See [Core lifecycle](CORE_SERVICE.md) and [request recovery](WEB_RECOVERY.md).
