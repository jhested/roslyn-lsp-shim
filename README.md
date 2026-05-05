# roslyn-lsp-shim

A small stdio LSP proxy that lets **Claude Code**, **OpenCode**, and other LSP clients **navigate into source-generated C# code** through the official `roslyn-language-server`.

It wraps the real Roslyn LSP transparently and translates the Roslyn-specific virtual URI scheme (`roslyn-source-generated://`) into normal `file://` paths under a temp directory. Clients that don't implement Roslyn's `workspace/textDocumentContent` request — go-to-definition, find-references, and friends just start working.

[![CI](https://github.com/jhested/roslyn-lsp-shim/actions/workflows/ci.yml/badge.svg)](https://github.com/jhested/roslyn-lsp-shim/actions/workflows/ci.yml) ![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

## Do I need this?

You probably do if you've seen this pattern:

| Symptom | Status |
|---|---|
| Build is green, type checking works in the editor | ✅ |
| Diagnostics on `[GeneratedRegex]` / `[JsonSerializable]` / source-generated types | ✅ |
| Go-to-definition on a generated symbol | ❌ jumps to nothing |
| Find-references includes the generated implementation | ❌ silently empty |

| Editor / agent | Needs the shim? |
|---|---|
| VS Code with C# Dev Kit | No — handles the virtual URIs natively |
| Rider | No |
| Neovim with `roslyn.nvim` | No |
| **Claude Code** | **Yes** |
| **OpenCode** | **Yes** |
| Any other generic LSP client without `workspace/textDocumentContent` | Yes |

The alternative is to set `EmitCompilerGeneratedFiles=true` in your `.csproj` so the generator output lands on disk. That works fine and you may prefer it. The shim is for when you want navigation to "just work" without modifying every project's build.

## Install

Prerequisites:

```bash
# .NET SDK (8+ for older generators, 10+ recommended for current Roslyn LSP)
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel LTS
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"

# The official Roslyn LSP, as a dotnet global tool
dotnet tool install --global roslyn-language-server --prerelease
```

Then the shim itself:

```bash
npm install -g github:jhested/roslyn-lsp-shim
```

(Or clone and `npm link` if you want to hack on it.)

Verify:

```bash
which roslyn-language-server   # should be ~/.dotnet/tools/roslyn-language-server
which roslyn-lsp-shim           # should be the npm global bin
```

Don't forget to persist `DOTNET_ROOT` and the two `PATH` entries in your shell profile (`~/.zshrc` / `~/.bashrc`) — the Roslyn LSP refuses to start without `DOTNET_ROOT`.

## Configure

### Claude Code

`ENABLE_LSP_TOOL=1` must be set (in `~/.claude/settings.json` or your shell profile). In your C# LSP plugin's `.lsp.json`, point `command` at the shim:

```json
{
  "csharp": {
    "command": "roslyn-lsp-shim",
    "args": ["--stdio"],
    "extensionToLanguage": {
      "cs": "csharp",
      "razor": "csharp",
      "cshtml": "csharp"
    },
    "transport": "stdio"
  }
}
```

### OpenCode

In `~/.config/opencode/opencode.json` (or per-project):

```json
{
  "lsp": {
    "csharp": {
      "command": ["roslyn-lsp-shim", "--stdio"],
      "extensions": [".cs", ".cshtml", ".razor"]
    }
  }
}
```

Anything you'd normally pass to `roslyn-language-server` (`--logLevel`, `--extension`, etc.) goes after the binary; the shim forwards all argv straight through.

## One-shot install via your AI coding agent

Paste this into Claude Code or OpenCode and let it do the work:

> Install [roslyn-lsp-shim](https://github.com/jhested/roslyn-lsp-shim) so I get go-to-definition into source-generated C# code.
>
> 1. If `dotnet` is not on `PATH`, install the latest LTS .NET SDK to `~/.dotnet` using `https://dot.net/v1/dotnet-install.sh`.
> 2. Make sure `DOTNET_ROOT="$HOME/.dotnet"` and `~/.dotnet:~/.dotnet/tools` are on `PATH` (in my shell profile and the current session).
> 3. If `roslyn-language-server` is not on `PATH`, run `dotnet tool install --global roslyn-language-server --prerelease`.
> 4. Run `npm install -g github:jhested/roslyn-lsp-shim`.
> 5. Update my LSP configuration so `csharp` uses `roslyn-lsp-shim` instead of `roslyn-language-server` (keep any existing args). For Claude Code update the relevant `.lsp.json` and ensure `ENABLE_LSP_TOOL=1` in `~/.claude/settings.json`. For OpenCode update `~/.config/opencode/opencode.json`.
> 6. Verify by running `which roslyn-lsp-shim` and `which roslyn-language-server`.
>
> Confirm what you changed and stop short of editing my `.csproj` files — this shim replaces the need for `EmitCompilerGeneratedFiles`.

## How it works

```
   ┌──────────────┐                      ┌─────────────────┐                      ┌────────────────────────┐
   │  LSP client  │ ──── stdio LSP ────▶ │ roslyn-lsp-shim │ ──── stdio LSP ────▶ │ roslyn-language-server │
   │  (Claude /   │ ◀──────────────────  │   (Node.js)     │ ◀──────────────────  │      (.NET tool)       │
   │   OpenCode)  │                      └─────────────────┘                      └────────────────────────┘
   └──────────────┘                              │
                                                 │   server returns:
                                                 │     roslyn-source-generated://...
                                                 │
                                                 │   shim issues `workspace/textDocumentContent`,
                                                 │   writes result to /tmp/roslyn-generated-XXX/<sha1>.cs,
                                                 │   rewrites response to file:// before forwarding
```

In detail:

1. The shim's stdin is the parent client's view of the LSP server. Its child stdin is the real Roslyn LSP. JSON-RPC messages are forwarded transparently in both directions.
2. When the shim sees `roslyn-source-generated://...` in any outbound (server→client) message, it issues `workspace/textDocumentContent` (LSP 3.18) to the server, writes the response text to a stable temp path keyed by `sha1(uri)`, and rewrites the URI in the message to `file://...` before forwarding.
3. When the parent client later sends a request referencing one of those temp paths (e.g., a hover after navigating in), the shim rewrites the URI back to its original virtual form before forwarding to the server.
4. Server-pushed `workspace/textDocumentContent/refresh` requests trigger a re-fetch of the affected URI; the shim answers them itself so the client never sees them.
5. On exit the shim removes its per-instance temp directory under `$TMPDIR/roslyn-generated-<random>/`.

The shim also injects `workspace.textDocumentContent` into the client's `initialize` capabilities so the server is willing to use the virtual URI scheme in the first place.

### Project auto-discovery

The Roslyn LSP only analyses projects that have been explicitly opened via `solution/open` or `project/open`. Many LSP clients (Claude Code's LSP tool, OpenCode) don't send those notifications, which leaves cross-project navigation broken — the server falls back to `MetadataAsSource` decompilation of the referenced `.dll`, which **does not include source-generator output**. Symptom: go-to-definition on a type that lives in a referenced project's source generator returns nothing, or jumps to a stub that's missing the generated members.

To fix this, when the parent client signals `initialized`, the shim walks the workspace folders captured from `initialize` (`rootUri` / `workspaceFolders`) and discovers `.sln`/`.slnx`/`.slnf` or, failing that, every `.csproj`/`.vbproj`/`.fsproj`. It then sends `solution/open` (preferred) or a `project/open` listing every project so Roslyn loads the full graph. Idempotent if the client also opens projects itself.

Traversal skips `node_modules`, `bin`, `obj`, `.git`, `.vs`, `.idea`, and is depth-capped (default 5). Tune with the env vars below if you need to.

## Limitations

- **Read-only.** The temp files exist solely as a navigation target. The shim drops `didOpen`/`didChange`/`didClose` notifications on those paths because the Roslyn server does not accept document lifecycle events for source-generated documents.
- **String-level URI rewriting.** The shim walks every string in JSON messages and rewrites anything matching the virtual URI scheme. In practice this only ever appears in real URI fields. If a real-world LSP message ever embeds the virtual URI in plain text (a description, a tooltip), that text would also be rewritten. None of the LSP methods I'm aware of do this.
- **One server per shim instance.** The shim is 1:1 with the wrapped server, same as if you launched the server directly.
- **`workspace/textDocumentContent` is LSP 3.18.** The current `roslyn-language-server` (5.x) uses it. Older `roslyn-language-server` builds used a custom `sourceGeneratedDocument/_roslyn_getText` method; the shim is built for the current method only.

## Environment variables

| Variable | Purpose |
|---|---|
| `ROSLYN_LSP_CMD` | Override the wrapped server binary (default `roslyn-language-server`). Useful when the binary is at a non-standard path. |
| `ROSLYN_SHIM_LOG` | If set, append shim debug logs to this file. Unset for silent operation. |
| `ROSLYN_SHIM_NO_AUTOLOAD` | Set to `1` to disable the project auto-discovery step. Use this if your client already opens projects/solutions itself and you want full control. |
| `ROSLYN_SHIM_AUTOLOAD_DEPTH` | Max directory depth when scanning for `.sln`/`.csproj` (default `5`). |

## Try it locally

```bash
git clone https://github.com/jhested/roslyn-lsp-shim
cd roslyn-lsp-shim
npm test                  # fast: unit + initialize round-trip with the real LSP
npm run test:e2e          # slower: builds the example projects under examples/,
                          # opens them via the shim, navigates into source-
                          # generated code, verifies content of temp files.
```

Two example workspaces:

- **`examples/sample-project/`** — minimal single-project `[GeneratedRegex]` consumer. Verifies in-project go-to-implementation through the shim.
- **`examples/multi-project/`** — three-project graph (`Generator` → `Producer` → `Consumer`) where the source generator runs in `Producer` but is consumed from `Consumer`. Verifies cross-project go-to-definition into source-generator output. Reproduces the failure mode where, without auto-load, the LSP falls back to `MetadataAsSource` decompilation and navigation breaks.

Both deliberately do **not** set `EmitCompilerGeneratedFiles`, so they exercise the actual problem the shim solves.

## Development

The whole shim is a single file (`src/shim.js`, ~270 lines, no runtime dependencies). Read it top-to-bottom — it's structured as: framing → URI maps → child plumbing → outbound translation (`fetchGeneratedContent`) → client→server handler → server→client handler → cleanup.

Set `ROSLYN_SHIM_LOG=/tmp/shim.log` to watch the URI translations live:

```
[2026-05-06T08:42:19Z] shim started; server cmd: roslyn-language-server args: --stdio
[2026-05-06T08:42:21Z] fetching 1 virtual uri(s) for id=10
[2026-05-06T08:42:23Z] refresh requested for roslyn-source-generated://...
```

Issues and PRs welcome at <https://github.com/jhested/roslyn-lsp-shim>.

## License

[MIT](LICENSE).
