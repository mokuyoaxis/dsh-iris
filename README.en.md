<p align="center">
  <sub><a href="README.md">简体中文</a> | English</sub>
</p>

<p align="center">
  <img src="docs/assets/logo/iris-interim-flower.png" width="240" alt="Iris line-art flower (interim mark)">
</p>

<h1 align="center">Iris</h1>

<p align="center"><strong>A multimodal workspace for your Agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mokuyoaxis/dsh-iris"><img alt="npm version" src="https://img.shields.io/npm/v/%40mokuyoaxis%2Fdsh-iris.svg?style=flat-square"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D22-339933.svg?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white"></a>
  <a href="https://github.com/mokuyoaxis/dsh-iris/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/mokuyoaxis/dsh-iris/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-1689FF.svg?style=flat-square"></a>
</p>

Iris connects media services and keeps creative work, tasks and outputs together. Agents can generate, edit, inspect and reuse media through a standalone CLI, a native DSH plugin, or the 0.3 alpha Core workbench and generic MCP. Core owns execution and storage; users choose what each client can access.

**Release channels: `0.3.0-alpha.1` is the first 0.3 prerelease, available through npm `alpha`; stable `latest` remains `0.2.7`.** The standalone Web workbench, production MCP, ComfyUI and Core plugins require the alpha package. Stable 0.2.7 does not include these new entry points. Alpha contracts can change; see the [release notes](docs/releases/0.3.0-alpha.1.md) for scope.

| What you need | Entry | Availability |
|---|---|---|
| Media tools and prompt refinement inside DSH | [DSH plugin](#dsh-plugin-027) | Published 0.2.7 |
| Media generation, task inspection and export in a terminal | [Standalone CLI](#standalone-cli-027) | Published 0.2.7; no DSH required |
| A dedicated UI for models, creation and works | [Core quickstart](docs/CORE_QUICKSTART.md) | 0.3.0-alpha.1 / current source |
| Other Agents sharing the same media workspace | [MCP](docs/MCP.md) · [Agent guide](docs/AGENT_CORE_QUICKSTART.md) | 0.3.0-alpha.1 / current source |

## Workbench preview

A white interface with subtle iris colors, light/dark themes, local backgrounds and mobile layouts. Advanced parameters and details start collapsed.

![Core studio: a real Run, image preview, selection and download](docs/assets/screenshots/core-studio-preview.webp)

| Capability overview | Function model pools |
|---|---|
| ![Core overview: six capabilities and their actual entries](docs/assets/screenshots/core-overview-preview.webp) | ![Function pools: automatic, manual and disabled policies](docs/assets/screenshots/core-model-pools-preview.webp) |
| **Health spectrum and connection checks** | **MCP capabilities and operation permissions** |
| ![Six-capability spectrum and optional keepalive](docs/assets/screenshots/core-spectrum-preview.webp) | ![Client authorization by image capability and operation scope](docs/assets/screenshots/core-connections-preview.webp) |

> Real UI from the current source, using an isolated demo workspace and works from the earlier controlled replay. This capture session makes no paid-model or ComfyUI GPU calls. Only built-in themes are shown, without a personal background. See the [full gallery](docs/screenshots.md) for mobile, dark mode and provenance.

## What Iris provides

- **Media and vision:** image generation/editing, video, music, speech, transcription and visual understanding, plus local crop, difference, video-frame and HTML screenshot tools. Entry-point coverage differs; see below.
- **Per-function model pools:** automatic selection, a manually ordered list, or disabled. Automatic pools use confirmed, eligible models in stable order. Switching requires known non-acceptance; existing tasks keep their original binding.
- **Persistent creative work:** Core stores tasks, artifacts and fixed flows. Inspect the original request, recover outputs, select an image and continue using it. Unknown acceptance never triggers automatic regeneration.
- **User-selected Agent access:** MCP grants select media, operation scopes and tools. stdio and Streamable HTTP share Core, with generic configuration and explicit client templates.
- **Optional plugins:** Providers, business operations, pages, settings forms and artifact previews can be contributed by plugins. Core validates and assembles them; users grant access. The bundled contact sheet demonstrates a complete persistent business.

### Current entry-point coverage

| Capability | DSH / standalone CLI (alpha) | Core Web / MCP (alpha) |
|---|---|---|
| Image generation, import and editing | Available | Available; text-to-image requires a new generation-capable root |
| Speech and transcription | Available | Available in a new v3 root |
| Video, music and vision | Available, depending on service and local dependencies | Configurable uses; creation entries still pending |
| ComfyUI workflows and exposed parameters | Added in alpha; absent from stable 0.2.7 | Implemented; live GPU inference remains unverified |
| Contact-sheet plugin | Outside 0.2.7 | Available when explicitly enabled |

“Available” means an implemented entry, requiring a supported protocol, model and grant. A listed model, eligible candidate, reachable connection and successful media test are different facts. Speech and ComfyUI development checks include controlled services; they do not establish compatibility with arbitrary upstreams.

## Quickstart

### Core workbench (0.3 alpha)

Pin the prerelease in your own project, then choose a **new private location**. Existing workspaces are not migrated:

```bash
npm install @mokuyoaxis/dsh-iris@0.3.0-alpha.1

IRIS_PREVIEW="$HOME/.iris/preview"
mkdir -p "$IRIS_PREVIEW"
npx dsh-iris flow init --data-root "$IRIS_PREVIEW/core"
npx dsh-iris execution init --audio --data-root "$IRIS_PREVIEW/core"
npx dsh-iris config init --provider-config "$IRIS_PREVIEW/providers.json"

npx dsh-iris web serve \
  --data-root "$IRIS_PREVIEW/core" --auth-store "$IRIS_PREVIEW/auth" \
  --provider-config "$IRIS_PREVIEW/providers.json" \
  --allow-provider-management --allow-execution --allow-selection \
  --connection-store "$IRIS_PREVIEW/connections" \
  --allow-connection-management --allow-mcp --port 3182
```

For a source checkout, install locked dependencies with `npm ci` and replace `npx dsh-iris` with `node bin/dsh-iris.js`. Use `@mokuyoaxis/dsh-iris@alpha` to follow prereleases, or keep the exact version for a reproducible setup.

Open the printed **`loginUrl` once to set an access password**, then use the ordinary address. Remembered devices survive refreshes and normal restarts; sign back in with the same password after logout. Mobile browsers do not need access to Termux files.

In **模型服务** (Model services), add a connection, read or enter exact models and confirm their uses. Choose a policy under **功能模型池** (Function pools), then generate in **创作** (Studio). Starting the service, editing configuration and reading a directory do not generate media. Clicking Generate calls the provider and may incur charges.

Under **客户端** (Clients), create a connection, choose capabilities and permissions, then generate and merge the appropriate MCP configuration into your client. **Keep Core running.** stdio starts a bridge; HTTP uses the same service's `/mcp`. Templates do not install clients or grant additional access. Keep exported connection configuration private.

See the [Core quickstart](docs/CORE_QUICKSTART.md) for login, recovery, switch descriptions and an Agent example. Enable plugins separately through an [explicit startup selection](docs/PLUGIN_STARTUP.md). Iris does not scan user disks or install plugin code automatically.

### DSH plugin (0.2.7)

Check `dsh --version`, Node.js ≥22 and `pnpm` on PATH. Iris 0.2.7 declares the 12 exact DSH versions in its [compatibility matrix](docs/DSH_COMPATIBILITY.md); other versions need separate verification.

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.2.7
dsh web
```

Under Settings → Iris Workbench, reference an existing DSH API-key connection or add a service. Choose its protocol, approve model uses and select pool policies. Native DSH mode uses host routes, attachments and lifecycle without a separate Core Web service; it provides 17 Agent tools and the 🫧 prompt-refinement entry.

These commands retain the stable version. To use additions such as the alpha ComfyUI UI, explicitly install `dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.3.0-alpha.1`. The exact supported host versions do not expand.

After configuration, a minimal request is:

```text
Use iris_draw_image to draw a white cat sitting beside a blue window.
Use Iris to generate retro-rock background music and save it as an audio artifact.
```

See the [user guide](user_guide.md) and [release-oriented Agent prompt](docs/AGENT_QUICKSTART.md). Updates require a normal plugin backend reload and client refresh; an Agent should not restart unrelated work.

### Standalone CLI (0.2.7)

Install in your own project; DSH is not required:

```bash
npm install @mokuyoaxis/dsh-iris@0.2.7
npx dsh-iris --help
```

Supply an explicit `--data-root` and private `--provider-config` for generation, task inspection and artifact export. See [Headless CLI](docs/HEADLESS_CLI.md). Its [`iris-core` Skill](docs/CORE_SKILLS.md) can be installed into an explicitly chosen Skills directory. An MCP connection has a separate permission-matched Skill.

Keep the full scoped package name **`@mokuyoaxis/dsh-iris`** when installing or searching a marketplace. The unscoped `dsh-iris` is a different plugin.

## Configuration and data

- Iris does not scan other projects or clients by default. DSH can [reference host API-key connections](docs/DSH_PROVIDER_CONNECTIONS.md); the Core workbench manages its media services. A chat subscription or OAuth login is not media API authentication.
- Existing lists and missing/empty assignments are not silently enabled on upgrade. New directory models need explicit use approval; an empty manual pool stays empty. See [function pools](docs/FUNCTION_MODEL_POOLS.md).
- `IRIS_IMPORT_WORKBENCH_CONFIG` explicitly selects an old ai-paint configuration for [one-time import](user_guide.md#从旧工作台显式导入). It does not modify or continuously synchronize the source, or migrate a Core data root.
- DSH data lives under `$DSH_HOME/iris/v1/`, with media Core data in `core-v0`. Standalone CLI/Web use the selected root. The new workbench does not automatically import works from other roots.
- Each root has one writer and an instance execution queue; read-only inspection may coexist. The gallery is not a backup. There is no automatic disk quota or garbage collection; deletion, recovery and dependencies require explicit operations.
- Credentials live in private storage: typically `0600` files and `0700` directories on POSIX. Windows still relies on accounts and ACLs. Keep secrets and authenticated URLs out of public configuration and captures. Workspace passwords, MCP credentials and provider keys are managed separately.

Node.js ≥22 and a loadable `sharp` installation are required. Video extraction needs `ffmpeg`/`ffprobe`. HTML capture needs the chosen browser backend; DSH host services and standalone Chromium have different requirements. On Termux/PRoot, keep data on a private Linux filesystem supporting permissions and hard links.

## Real generation and native DSH

<p align="center">
  <img src="docs/assets/examples/iris-flower-generated.webp" width="520" alt="A blue-purple iris actually generated through Iris">
</p>

> Historical real generation: the draft “iris flower” was refined using `deepseek-v4-flash` (thinking off), then generated through DashScope `qwen-image-3.0-pro` at 2048×2048. This is separate from the controlled replay used for the new workbench captures.

<details>
<summary>Native DSH on Android 16 / Termux</summary>

| Prompt entry | Refined draft |
|---|---|
| ![DSH prompt refinement entry](docs/assets/screenshots/prompt-general-before.webp) | ![Refined prompt written to the draft](docs/assets/screenshots/prompt-general-after.webp) |

![Succeeded DSH image task](docs/assets/screenshots/image-task-succeeded.webp)

Historical device captures from an Android browser connected to DSH in Termux/PRoot Debian ARM64, using the host's default skin. [Full sequence and provenance](docs/screenshots.md).

</details>

## Documentation and development

| Topic | Documentation |
|---|---|
| Getting started | [Core quickstart](docs/CORE_QUICKSTART.md) · [Agent Core guide](docs/AGENT_CORE_QUICKSTART.md) · [DSH guide](user_guide.md) · [CLI](docs/HEADLESS_CLI.md) |
| Workbench and connections | [Login](docs/WORKBENCH_LOGIN.md) · [Web](docs/LOCAL_WEB.md) · [MCP](docs/MCP.md) · [Skills](docs/CORE_SKILLS.md) |
| Models and flows | [Providers, pools and spectrum](docs/PROVIDER_SETTINGS.md) · [Images / ComfyUI](docs/IMAGE_GENERATION.md) · [Speech / transcription](docs/AUDIO_FLOWS.md) · [Task semantics](docs/TASK_SEMANTICS.md) |
| Extensions | [Plugin contract](docs/PLUGINS.md) · [Startup](docs/PLUGIN_STARTUP.md) · [Panel](docs/PANEL_EXTENSIONS.md) · [Contact sheet](docs/CONTACT_SHEET.md) |
| Releases and direction | [0.3 alpha release notes](docs/releases/0.3.0-alpha.1.md) · [0.2.7 stable](docs/releases/0.2.7.md) · [CHANGELOG](CHANGELOG.md) · [ROADMAP](docs/ROADMAP.md) · [Architecture](docs/ARCHITECTURE.md) |

The DSH package retains [`iris-use`](.dsh/skills/iris-use/SKILL.md), [`iris-compose-media`](.dsh/skills/iris-compose-media/SKILL.md) and [`iris-verify-ui`](.dsh/skills/iris-verify-ui/SKILL.md). Core and connection Skills do not replace them.

The project uses ES Modules and needs no build step. Install the locked dependencies and run `npm test`; browser verification uses a real local service with controlled upstreams. New Core plugin contracts and configuration remain experimental, without a marketplace or stable SDK commitment. Specific verified Agent connections do not establish attachment presentation in every client.

[MIT License](LICENSE)
