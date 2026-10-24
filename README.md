# Antigravity Quota Lens

Monitor the quota reported by Antigravity IDE from its status bar. This extension shows remaining quota percentages and reset countdowns; it does not count individual input or output tokens.

## Features

- Gemini 5-hour and weekly remaining quota with reset countdowns.
- Optional available prompt credits in the status bar.
- Hover details for Gemini and, when reported, Claude quota groups and account credits.
- Warning background at 40% remaining or below; error background at 20% or below.
- Click to refresh, change display format, copy a quota summary, or open settings.

## Requirements and installation

Requires desktop Antigravity IDE and a running Antigravity language server. The extension uses VS Code extension APIs, but ordinary VS Code alone does not provide the required language server.

Install from your extension registry, or use **Extensions → Install from VSIX…** and select the release package. Reload the IDE if prompted.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `antigravityQuota.displayFormat` | `both` | `both`, `compactBoth`, `5hOnly`, or `weeklyOnly`. |
| `antigravityQuota.pollingInterval` | `30` | Refresh interval in seconds, between 5 and 600. |
| `antigravityQuota.showCredits` | `false` | Include available prompt credits in the status bar. |
| `antigravityQuota.statusBarPriority` | `100` | Placement within the right-aligned status bar; reload after changing. |

## Commands

- **Antigravity Quota: Refresh Quota Now**
- **Antigravity Quota: Show Quota Details**
- **Antigravity Quota: Copy Quota Summary to Clipboard**

## Privacy and compatibility

The extension discovers the local language server process and its authentication token, holds quota responses in memory, and sends HTTPS requests only to `127.0.0.1`. It has no external telemetry endpoint. Copying a summary writes account quota and credit information to your clipboard at your request.

It uses Antigravity internal APIs, which may change without notice. Local self-signed TLS is accepted for the loopback connection. Windows discovery uses PowerShell process queries; macOS and Linux require `ps` and `lsof`. Compatibility with a live Antigravity session must be checked before release.

If the status bar shows **Quota: Offline**, ensure Antigravity is running and use the refresh command.

## License

MIT. Independent project; not affiliated with or endorsed by Google.
