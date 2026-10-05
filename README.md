# Antigravity Quota Lens

A sleek, lightweight VS Code extension designed specifically for **Antigravity IDE** to display real-time **Gemini token usage**, **5-hour sprint quotas**, and **weekly credit limits** persistently in the IDE window without navigating into settings.

---

## ✨ Features

- **Persistent Status Bar Visibility**: Positioned right next to your zoom and window layout controls in the bottom status bar (`$(pulse) Gemini: 94% (2h 36m) | 500 Credits`).
- **Dynamic Color Warnings**: Automatically updates colors based on remaining quota:
  - 🟢 **Normal (> 50%)**: Standard theme color
  - 🟡 **Warning (20% – 50%)**: Yellow warning badge
  - 🔴 **Critical (< 20%)**: Red error badge
- **Rich Hover Tooltip**:
  - Exact percentage remaining for your preferred model.
  - Visual ASCII/Unicode quota progress bar `[█████████░]`.
  - 5-Hour sprint window reset countdown (`2h 36m remaining`).
  - Active model breakdown table (Gemini 3.8 Flash, Gemini 3.1 Pro, Claude Opus 4.6, Claude Sonnet 4.6, GPT-OSS 120B).
  - Available prompt credits and flow credits.
- **Interactive QuickPick Menu**: Click the status bar item to:
  - 🔄 Manually refresh quota on demand.
  - ⚡ Switch the primary tracked model directly from a dropdown list.
  - 📋 Copy a formatted Markdown quota report to the clipboard.
  - ⚙️ Access extension settings.
- **100% Local & Zero Overhead**: Directly queries the local Antigravity Language Server running on `127.0.0.1` via HTTPS with automatic process discovery. No external servers or API keys needed.

---

## ⚙️ Configuration Settings

Customize behavior via `Settings -> Extensions -> Antigravity Quota Monitor`:

| Setting | Default | Description |
| :--- | :---: | :--- |
| `antigravityQuota.pollingInterval` | `30` | Interval in seconds to automatically poll quota from the language server. |
| `antigravityQuota.preferredModel` | `Gemini 3.8 Flash (High)` | Primary model to display in the status bar. |
| `antigravityQuota.showCountdown` | `true` | Show countdown timer for the 5-hour rolling sprint window. |
| `antigravityQuota.showCredits` | `true` | Show available prompt credits. |
| `antigravityQuota.compactMode` | `false` | Enable minimal view (`$(pulse) 94% (2h 36m)`) to save status bar width. |
| `antigravityQuota.statusBarPriority` | `100` | Position weight in the status bar (adjusts proximity to zoom/layout controls). |

---

## ⌨️ Commands

- `Antigravity Quota: Refresh Quota Now`
- `Antigravity Quota: Show Quota Details`
- `Antigravity Quota: Copy Quota Summary to Clipboard`
