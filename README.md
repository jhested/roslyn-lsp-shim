# roslyn-lsp-shim

A small stdio LSP proxy that lets **Claude Code**, **OpenCode**, and other LSP clients navigate into source-generated C# code through the official `roslyn-language-server`. It translates Roslyn's `roslyn-source-generated://` URIs into normal `file://` paths under a temp directory so go-to-definition and find-references just work.

[![CI](https://github.com/jhested/roslyn-lsp-shim/actions/workflows/ci.yml/badge.svg)](https://github.com/jhested/roslyn-lsp-shim/actions/workflows/ci.yml) ![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

## Do I need this?

You probably do if you've seen this pattern:

| Symptom | Status |
|---|---|
| Build is green, type checking works in the editor | ✅ |
| Diagnostics on `[GeneratedRegex]` / `[JsonSerializable]` / generated types | ✅ |
| Go-to-definition on a generated symbol | ❌ jumps to nothing |
| Find-references includes the generated implementation | ❌ silently empty |

Editors that already handle Roslyn's virtual URIs (VS Code C# Dev Kit, Rider, Neovim with `roslyn.nvim`) **don't** need the shim. Claude Code, OpenCode, and other clients without `workspace/textDocumentContent` support **do**.

The alternative is `EmitCompilerGeneratedFiles=true` in your `.csproj` so generator output lands on disk. That works fine — use the shim when you'd rather not modify every project's build.

## Install

```bash
# .NET SDK + Roslyn LSP (skip if you already have them)
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel LTS
export DOTNET_ROOT="$HOME/.dotnet"                                # also persist
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"             # in your shell rc
dotnet tool install --global roslyn-language-server --prerelease

# The shim itself
npm install -g github:jhested/roslyn-lsp-shim
```

Verify: `which roslyn-lsp-shim` and `which roslyn-language-server` should both resolve. (Or clone and `npm link` if you want to hack on it.)

## Configure

### Claude Code

Set `ENABLE_LSP_TOOL=1` in `~/.claude/settings.json`. In your C# LSP plugin's `.lsp.json`:

```json
{
  "csharp": {
    "command": "roslyn-lsp-shim",
    "args": ["--stdio"],
    "extensionToLanguage": { "cs": "csharp", "razor": "csharp", "cshtml": "csharp" },
    "transport": "stdio"
  }
}
```

### OpenCode

In `~/.config/opencode/opencode.json`:

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

Anything you'd normally pass to `roslyn-language-server` (`--logLevel`, `--extension`, …) goes after the binary; the shim forwards argv straight through.

## One-shot install via your AI coding agent

Paste this into Claude Code or OpenCode:

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

The shim is a transparent stdio proxy: JSON-RPC messages flow between client and server unchanged, except for two interventions.

**URI translation.** When the server returns a `roslyn-source-generated://` URI, the shim issues `workspace/textDocumentContent` (LSP 3.18) to fetch its content, writes the result to a stable temp file (keyed by `sha1(uri)`), and rewrites the URI to `file://...` before forwarding. Inverse rewriting on the way back. Server-pushed `workspace/textDocumentContent/refresh` requests are intercepted and answered by the shim. The shim also injects the `workspace.textDocumentContent` client capability into `initialize` so the server is willing to use virtual URIs in the first place.

**Project auto-discovery.** The Roslyn LSP only analyses projects opened via `solution/open` or `project/open`, and most clients don't send those — leaving cross-project navigation broken because the server falls back to `MetadataAsSource` decompilation of referenced DLLs, which doesn't include source-generator output. After the parent client signals `initialized`, the shim scans the workspace folders captured from `initialize`, finds `.sln`/`.slnx`/`.slnf` (preferred) or every `.csproj`/`.vbproj`/`.fsproj`, and opens them. Idempotent if the client also opens projects. Skips `node_modules`/`bin`/`obj`/`.git`/`.vs`/`.idea`; depth-capped at 5 levels.

The per-instance temp directory at `$TMPDIR/roslyn-generated-<random>/` is removed on exit.

## Limitations

- **Read-only.** Temp files are navigation targets only. The shim drops `didOpen`/`didChange`/`didClose` for those paths because Roslyn doesn't accept lifecycle events on source-generated documents.
- **String-level URI rewriting.** The shim walks every string in JSON messages and rewrites anything matching the virtual URI scheme. In practice this only ever appears in real URI fields, but if a future LSP message embeds the virtual URI in plain text, that text would also be rewritten.
- **`workspace/textDocumentContent` is LSP 3.18.** Older `roslyn-language-server` builds used a custom `sourceGeneratedDocument/_roslyn_getText`; the shim only speaks the current method.

## Environment variables

| Variable | Purpose |
|---|---|
| `ROSLYN_LSP_CMD` | Override the wrapped server binary (default `roslyn-language-server`). |
| `ROSLYN_SHIM_LOG` | Path to append shim debug logs. Unset for silent operation. |
| `ROSLYN_SHIM_NO_AUTOLOAD` | Set to `1` to disable project auto-discovery (use if your client already calls `solution/open` / `project/open`). |
| `ROSLYN_SHIM_AUTOLOAD_DEPTH` | Max directory depth when scanning for projects (default `5`). |

## Try it locally

```bash
git clone https://github.com/jhested/roslyn-lsp-shim
cd roslyn-lsp-shim
npm test            # unit + smoke
npm run test:e2e    # builds examples/, drives end-to-end navigation
```

Two example workspaces, both deliberately without `EmitCompilerGeneratedFiles`:

- **`examples/sample-project/`** — single-project `[GeneratedRegex]`. Tests in-project navigation.
- **`examples/multi-project/`** — `Generator` → `Producer` → `Consumer`. Tests cross-project go-to-definition. Without the shim's auto-load, this is the failure mode where Roslyn falls back to `MetadataAsSource` and navigation breaks.

## Development

The shim is a single ~450-line file (`src/shim.js`, no runtime dependencies). Set `ROSLYN_SHIM_LOG=/tmp/shim.log` to watch URI translations and autoload events live.

Issues and PRs welcome at <https://github.com/jhested/roslyn-lsp-shim>.

## License

[MIT](LICENSE).
