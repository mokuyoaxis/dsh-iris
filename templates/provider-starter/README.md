# Wan Provider starter / 万相供应商模板

A copyable, independent Provider plugin using only `@mokuyoaxis/dsh-iris/plugins` and the public `package.json` export to locate the CLI. It implements the Wan 2.6 asynchronous image protocol itself. It does not call Iris's private transports or duplicate its Task store, queue, authentication or MCP server.

This template requires **Core 0.3.0-beta.1 and Provider factory context v1**. It checks `PROVIDER_FACTORY_CONTEXT_VERSION === 1` before setup. Install the exact beta package or a verified compatible Core archive. The older alpha.1 package fails with an explicit feature error and creates no data.

## Copy and check

Copy this entire directory outside the Iris repository into a new project, then install the explicitly chosen Core archive in that project:

```bash
npm install --save-exact @mokuyoaxis/dsh-iris@0.3.0-beta.1
node scripts/protocol-smoke.mjs
npm test
```

These tests use synthetic credentials and loopback HTTP services only. They initialize new private temporary roots, run the actual installed Core CLI and formal HTTP MCP, and preserve their evidence directories. No provider account, paid call or harness configuration is involved. Archive acceptance separately checks the same template as its own npm tarball. The template has no runtime dependency beyond its Core peer and Node 22.1.0+.

`private: true` prevents accidentally publishing this example. Before publishing your own plugin, choose your package/plugin/contribution IDs, review its implementation and compatibility, update its independent versions, then deliberately remove that flag. The local `npm pack --ignore-scripts` acceptance does not publish anything.

## Configure a new workspace

Provide the correct workspace/region API **root** from your own account. Do not append `/api/v1` or `/compatible-mode/v1`. Export your credential through your normal secure environment mechanism before starting Core; do not paste the key into a command argument or this project. Setup receives only the environment variable's **name**:

```bash
npm run setup -- \
  --directory /absolute/path/to/new-private-wan-workspace \
  --endpoint https://YOUR-WORKSPACE-API-ROOT \
  --credential-env YOUR_WAN_KEY_VARIABLE
```

The parent directory must already exist. Setup refuses any existing target, even an empty directory, and refuses data inside the plugin project. It writes private Provider/startup files, initializes a new image-generation execution root through the public CLI, and prints exact `startArgv`. It never reads the key, starts a server, imports another harness's settings or submits a generation. Failed setup leaves its partial directory for inspection.

Run the printed argv to open Core Web. The default Web login uses Core's normal first-use access passphrase flow. The contributed protocol appears in Provider settings. Read its actual model directory, review the result, explicitly save the supported model and select its image-generation policy. Setup leaves the model list empty and image generation disabled until that selection. Discovering a directory grants no execution authority.

In Connections, select **image generation** and the required read/create/execute/stop permissions, then export the ordinary MCP configuration for your client. This Provider reuses the Core image tools; installing it does not add an independent MCP tool or grant a connection new rights. Core owns execution and artifacts. Keep the plugin installed at the configured path and its version unchanged while recovering its original tasks.

## Supported protocol and limits

- Identity: `example.wan-image` 0.1.0, contribution `example.wan-image.images` 0.1.0; Plugin/Adapter contract v0 plus factory context v1. Rename these together for your own implementation.
- `GET /api/v1/models?capabilities=IG&page_no=…&page_size=100`: validate a complete, stable directory of at most 1,000 rows, then expose only actually returned `wan2.6-t2i`. A recognized ID is an implementation boundary, not a fabricated model pool or proof of account availability.
- `POST /api/v1/services/aigc/image-generation/generation`: `X-DashScope-Async: enable`, `messages` text input, explicit `n` defaulting to 1, optional `width*height`. This is the Wan 2.6 format, not the older Wan 2.5 endpoint. Core's image Run currently requests one image; the adapter accepts 1–4 for other public consumers.
- Poll only the original `/api/v1/tasks/{task_id}`. Missing submission identity or malformed/oversized submission responses mean **unknown acceptance**. Never retry a POST or switch a model/exit automatically after an ambiguous submission.
- Download PNG results, at most 8 MiB each, into the exact new staging path supplied by Core. API requests refuse redirects; signed CDN downloads follow redirects through the same borrowed Core network port and receive no API Authorization header. JSON responses are limited to 1 MiB. Upstream details are not reflected into safe errors.
- No source upload, image edit, remote cancellation or unsupported model fallback. Stopping local waiting does not prove remote cancellation or stopped billing. Remote task IDs/result URLs have the vendor's limited lifetime; persistence cannot recover a vendor-expired result.
- The adapter owns no agents, background timers or queues. Core resolves the current credential for each factory, owns network routing/scheduling, and drains each full awaited method, including body reads and child requests. Await every request and body before returning; do not keep the borrowed port for later background work or dispose it.

The plugin is trusted Node code, not a network/filesystem sandbox. This reference intentionally uses only the borrowed `context.network.fetch` for its HTTP requests and writes only the supplied delivery file.

The protocol was checked against the official [Wan image API](https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference) and [model directory API](https://help.aliyun.com/zh/model-studio/list-models) on 2026-11-03. Acceptance uses controlled local responses; it does not certify a live account, region, billing behavior or every Wan model.
