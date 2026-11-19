# Core Workbench Quickstart · 从零启动工作台

This guide walks through setting up the **Iris 0.3.0** standalone Core workbench from scratch. If you are using DSH or the standalone CLI instead, see the [DSH User Guide](../user_guide.md) or [Headless CLI](HEADLESS_CLI.md); if you are upgrading from an older release, check the [upgrade guide](UPGRADING_0.3.md) first.

> [!NOTE]
> Choose a **new private directory** under your home folder on a filesystem that supports hard links (on Termux/PRoot, use the Linux home directory rather than Android shared storage). Existing workspaces are never modified or migrated automatically.

## Start a new workspace · 新建工作区

Iris requires **Node.js ≥22.1.0**. Install `@mokuyoaxis/dsh-iris@0.3.0` (or run `npm ci` inside a source checkout and replace `npx dsh-iris` with `node bin/dsh-iris.js`):

```bash
IRIS_PREVIEW="$HOME/.iris/preview"
mkdir -p "$IRIS_PREVIEW"

npx dsh-iris flow init --data-root "$IRIS_PREVIEW/core"
npx dsh-iris execution init --vision --data-root "$IRIS_PREVIEW/core"
npx dsh-iris config init --provider-config "$IRIS_PREVIEW/providers.json"

npx dsh-iris web serve \
  --data-root "$IRIS_PREVIEW/core" \
  --auth-store "$IRIS_PREVIEW/auth" \
  --provider-config "$IRIS_PREVIEW/providers.json" \
  --allow-provider-management --allow-execution --allow-selection \
  --connection-store "$IRIS_PREVIEW/connections" \
  --allow-connection-management --allow-mcp \
  --port 3182
```

`execution init --vision` creates a **v5** execution root with image, speech, transcription, text-to-video, vision, and OCR flows ready (without calling any provider). Each flag on `web serve` grants a clear, opt-in capability:

| Switch | What it enables |
|---|---|
| `--allow-provider-management` | Edit media services, models, and function pools in the UI |
| `--allow-execution` | Local imports, Run creation, and media execution |
| `--allow-selection` | Save an image selection on a completed Run |
| `--allow-connection-management` | Create, edit, revoke, and delete MCP client grants |
| `--allow-mcp` | Expose the `/mcp` Streamable HTTP endpoint alongside stdio |

The server binds to `127.0.0.1` and stays in the foreground (stop it cleanly with `Ctrl+C`). Only one execution writer may own a given data root at a time. To launch a read-only gallery instead, omit the write and management flags—see the [Core Web reference](LOCAL_WEB.md).

> [!TIP]
> If a read-only MCP connection needs to look up or recover historical Operations, keep the Core execution service running—read grants on the connection authorize access, while the execution service provides the lookup routes. See [Core operation recovery](CORE_SERVICE.md#接收查询与停止).

## Sign in · 登录

Open the printed **`loginUrl`** once in your browser to set your workspace access password. After setup, bookmark and use the regular `origin` URL—remembered devices stay signed in across page refreshes and normal restarts.

To retrieve a fresh login URL or reset your password without restarting the running server:

```bash
# Retrieve login address
npx dsh-iris web login \
  --data-root "$HOME/.iris/preview/core" \
  --auth-store "$HOME/.iris/preview/auth"

# Reset password and revoke active browser sessions (keeps works and MCP grants)
npx dsh-iris web password reset \
  --data-root "$HOME/.iris/preview/core" \
  --auth-store "$HOME/.iris/preview/auth"
```

Workspace passwords, provider API keys, and MCP connection credentials are stored and managed separately—see [login and recovery](WORKBENCH_LOGIN.md).

## Make the first work · 生成第一件作品

1. **Add a provider**: Open **模型服务 → 添加服务**, pick the documented protocol, enter your Base URL and API key (or choose no-auth for local endpoints), and save.
2. **Approve models**: Under **模型与用途**, sync the model directory or enter model IDs manually, check their intended capabilities, and save.
3. **Choose a pool policy**: Under **功能模型池**, set each capability to automatic, a manually ordered list, or disabled. Automatic pools select confirmed, healthy models in stable order.
4. **Generate**: Open **创作 → 生成图片**, select a configured model, enter your prompt, and click **开始生成**.

Browsing pages, inspecting the health spectrum, and syncing model catalogs are all read-only—billable requests happen only when you explicitly start generation. For ComfyUI setups, import an **API-format workflow** with mapped prompt/output nodes; see [ComfyUI workflows](IMAGE_GENERATION.md#comfyui-入口). For full provider and pool details, see [providers, pools, and health](PROVIDER_SETTINGS.md).

## Connect an Agent · 连接客户端

1. **Create a connection**: Open **客户端 → 新建连接**, name the client, select the media groups it needs (for example `image-edit`, `image-generate`, `vision`, or `ocr`), and choose scopes: **读取** (`read`), **导入与创建** (`create`), **执行流程** (`execute`), and optionally **停止等待** (`stop`).
2. **Export MCP config**: Under **接入配置**, check whether the Agent runs on the same machine as Core, choose **stdio** or **HTTP** (loopback `/mcp`), and merge the generated snippet into your client's MCP configuration. Keep Core running while clients connect, and keep exported configs private.
3. **Install the connection Skill (optional)**: Download the generated **连接专属 Skill** bundle—it documents only the tools granted to that connection without embedding credentials—and install it explicitly:

```bash
npx dsh-iris skills install \
  --bundle /absolute/path/to/iris-skill.json \
  --directory /absolute/path/to/client-skills
```

4. **Verify**: Reconnect your MCP client, refresh the workbench to view the recorded handshake, and test with a clear prompt:

```text
Use only this Iris MCP connection. Read the actual configured image models,
then generate one pale-purple iris flower with an explicitly permitted model.
Keep the original request UUIDs and inspect the original receipt until complete.
Read back the resulting artifact. Report its Run ID, artifact ID and actual status.
If acceptance or the result is unknown, inspect it; do not submit again automatically.
```

For setup prompts you can hand directly to an Agent, see the [Agent Core guide](AGENT_CORE_QUICKSTART.md). For transport specs, presets, and `mcp check`, see [MCP](MCP.md).

## Optional plugins and recovery · 可选插件与恢复

Optional plugins are loaded explicitly via a startup selection file—follow [plugin startup](PLUGIN_STARTUP.md) to try the bundled [contact sheet](CONTACT_SHEET.md) plugin and grant its business operation to a connection.

When restarting normally (`Ctrl+C` followed by the same `web serve` command), Core preserves all Runs, Tasks, Operations, and artifacts without re-submitting anything. If a process terminated uncleanly and left a stale writer lease, inspect the lease owner with `doctor` before performing an explicit recovery—see [Core lifecycle](CORE_SERVICE.md) and [request recovery](WEB_RECOVERY.md).
