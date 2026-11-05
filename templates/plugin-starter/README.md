# Iris Plugin Starter · 独立插件模板

A real, offline image-board plugin: choose existing Core images, make a PNG contact sheet, recover its original Operation after restart, and optionally expose the business to an explicitly authorized MCP connection. No provider account, GPU, or extra runtime dependency is required.

This project has its own package name, plugin ID, plugin version, page and PNG renderer. Its image business delegates to Iris's **public** `@mokuyoaxis/dsh-iris/contact-sheet` export, version `0.1.0`. It is a starting point for independent plugins, not a second copy of Core or a new image-generation protocol.

## Start · 开始使用

Requires Node.js 22+ and Core `0.3.0-alpha.1` or a later compatible 0.3 build. Stable Iris `0.2.7` has no plugin SDK. The template is distributed with Core beta.1; the older alpha.1 package does **not** contain this directory.

Copy `templates/plugin-starter` from a current Iris checkout into a **new** directory outside that checkout. From the installed beta.1 package, copy `node_modules/@mokuyoaxis/dsh-iris/templates/plugin-starter` instead. The copied project can use the public SDK already present in alpha.1:

```bash
cd /absolute/my-iris-plugin
npm install --save-dev --save-exact @mokuyoaxis/dsh-iris@0.3.0-beta.1
npm test
npm run setup -- --directory /absolute/new-private-demo
```

`setup` requires an existing parent and a destination that does not exist, outside the plugin project. It creates a private demo directory, initializes a fresh execution root, imports two plain-colour sample PNGs, and writes absolute plugin-entry paths to `plugins.json`. Existing directories are rejected; an interrupted setup is retained for inspection, not silently retried. It prints paths and the exact startup argv, without starting a server or installing anything.

Start the workbench in the foreground from this installed project:

```bash
npm exec -- dsh-iris plugins inspect --plugin-config /absolute/new-private-demo/plugins.json
npm exec -- dsh-iris web serve --data-root /absolute/new-private-demo/core \
  --plugin-config /absolute/new-private-demo/plugins.json --port 3182 \
  --connection-store /absolute/new-private-demo/connections \
  --allow-connection-management --allow-mcp
```

Use the printed login URL to set your workbench password. Open **灵感对照板**, select pictures, then click **制作对照板**. This business does not need `--allow-execution`; media creation and plugin operations have separate gates. Change the port explicitly if occupied. Keep the service running while a harness uses MCP.

## MCP · 用户明确选择

Loading a package, enabling a business, and authorizing a connection are separate steps. In **连接**, create a connection, deselect unused media groups, choose `example.starter-board.create`, and grant `read` + `execute` (`stop` is optional). Export the transport and configuration format accepted by your harness, then import that configuration there. Iris does not install or scan harnesses.

After connecting, inspect `iris_core_plugin_catalog` and use its actual `dependency` pin. For this template the business input is:

```json
{
  "artifactIds": ["artifact_<24 lowercase hex characters>"],
  "columns": 2,
  "cellSize": 256
}
```

Use real image IDs from the catalog, 1–16 images in desired order, 1–4 columns and a cell size of 128–512. Call `iris_core_plugin_call` with `{ key, operationId, dependency, input }`; generate a UUID once before submitting. Reuse that UUID only with identical input. After an uncertain response, use `iris_core_lookup` first. `iris_core_operation` reads the saved state; `iris_core_image` delivers the saved PNG. The test protocol driver under `scripts/` is only an acceptance probe, not an MCP client implementation for production harnesses.

## Develop · 修改与生命周期

| File | Responsibility |
|---|---|
| `index.mjs` | Independent identity, compatibility, declared Core commands, operation/page/renderer versions and activation |
| `web/board.mjs` | Shared session/API/theme, explicit submit, saved UUID lookup, listeners/timers/blob URL cleanup |
| `web/png.mjs` | Reads original artifact bytes through the provided API and releases its image URL on unmount |
| `scripts/setup.mjs` | New-directory-only initialization through the public CLI |
| `scripts/smoke.mjs` | Real Core/MCP acceptance using fresh, private temporary data |

Rename the package and plugin ID before sharing your own plugin. Update the IDs in `scripts/setup.mjs` and the acceptance expectations too. The page derives its operation ID from its own plugin identity; it does not hardcode a Core installation path or request an owner token. Declare every browser entry and CSS resource in the manifest. Files outside those declarations are not automatically served; keep browser modules self-contained unless a future public asset contract says otherwise.

The delegated operation declares only `artifact.read` and `artifact.import`, with `artifactIds` declared as source inputs. Core validates closed JSON input, source access, current authorization, durable execution and output registration. A direct `createCorePluginHost().call()` is not a durable Operation; use the workbench/API/MCP business route when persistence is required. The template owns no backend resources. If you add sockets, watchers or similar resources, register cleanup using `context.onDispose()` during `activate`, and make work observe its AbortSignal. Close workbenches/hosts before disposing their shared registry.

Core saves the exact plugin and contribution versions with each Operation. Treat changed business semantics as a plugin/operation version change. Upgrading the underlying contact-sheet implementation requires review; this template deliberately refuses a version other than `0.1.0`. An incompatible/missing plugin blocks new execution and cannot substitute for a saved version. History and committed image bytes remain Core-owned. Interrupted work is retained as interrupted; it is not automatically submitted again. Editing the plugin requires a normal service stop and restart; there is no hot reload.

These are trusted Node and same-origin browser modules. Shadow DOM isolates styles, not code. Load code you trust. The small Core command interface constrains business calls but does not sandbox arbitrary Node imports. No arbitrary plugin settings storage or credential-reference API is invented here.

## Acceptance · 自检范围

`npm test` creates a separate private temporary root and closes its own services. It verifies real PNG execution, explicit selection/authorization, duplicate UUID conflict, same-port restart, original bytes, dependency version change, plugin absence and reduced permissions. It prints a safe evidence path and PNG hash; temporary evidence is retained. It does not touch daily DSH/harness configuration or call a paid model. SDK-created test sessions use temporary owner tokens; ordinary CLI workbenches use password login.

The Iris repository additionally verifies packed Core and plugin archives outside the checkout and tests this page/renderer in a real browser. This does not establish compatibility with every harness, operating system or future plugin. See the public [plugin SDK](https://github.com/mokuyoaxis/dsh-iris/blob/main/docs/PLUGINS.md) and [startup guide](https://github.com/mokuyoaxis/dsh-iris/blob/main/docs/PLUGIN_STARTUP.md) for the full contracts.

To distribute your own package, review its identity/version/compatibility, replace this README, set your own repository metadata, and remove `private: true` deliberately when ready. Run `npm pack --ignore-scripts --dry-run --json`, inspect the allowlisted files, then test the real archive from another project before publishing. Keep the MIT attribution when reusing these files. Never include private demo roots or connection credentials in your package.
