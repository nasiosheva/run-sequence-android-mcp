# run-sequence-android-mcp

Maintained by [Nasio Sheva](https://github.com/nasiosheva). This project is a fork of android-mcp with a `run_sequence` tool. Existing Android tools remain available.
Build with `npm ci && npm run build`, then configure an MCP stdio client to run
`node /absolute/path/to/run-sequence-android-mcp/dist/index.js`.

Example tool arguments:

```json
{"device":"DEVICE_SERIAL","steps":[{"action":"tap","x":540,"y":700},{"action":"wait","durationMs":500},{"action":"key","key":"BACK"},{"action":"wait_for_element","text":"Tasks","timeoutMs":10000}]}
```

To verify an interaction, add an assertion step:

```json
{"steps":[{"action":"tap","x":540,"y":700},{"action":"assert_element","resourceId":"success_message","timeoutMs":5000},{"action":"assert_no_element","text":"Loading","timeoutMs":5000},{"action":"assert_app","packageName":"com.example.dashboard","timeoutMs":5000}]}
```

`run_sequence` also accepts `variables`, whose string values can be used as `{{name}}` in text, selectors, and `assert_app`:

```json
{"variables":{"email":"user@example.com"},"steps":[{"action":"text","text":"{{email}}"}]}
```

## Saved flows

Use `android_save_flow` once to persist a named sequence, then call `android_run_flow` with its name whenever the agent needs to repeat it. Saved flows keep default variables, which can be overridden at run time; `android_run_flow` also accepts the same optional `record` setting as `run_sequence`. `android_list_flows` shows the available flows and `android_delete_flow` removes one after an explicit `confirm: true`.

To permanently remove every saved flow and its stored variables, stop active recordings, and remove temporary MCP artifacts, call `android_clear_saved_data` with `{"confirm": true}`. Calling it without confirmation is a dry run. Only flows saved explicitly with `android_save_flow` persist across MCP sessions.

Flows are stored in `~/.android-mcp/flows.json` by default. Set `ANDROID_MCP_FLOWS_PATH` to place the flow store elsewhere.

Supported actions are `tap`, `swipe` (fromX, fromY, toX, toY, durationMs), `key` (BACK, HOME, ENTER, TAB), `wait` (durationMs), `text` (text, optional clear and submit), `wait_for_element`, `assert_element`, `assert_no_element` (selector-based), and `assert_app` (packageName, optional activity; all assertions accept timeoutMs). Consecutive input steps run in one ADB shell; waits and assertions run on the host. Non-ASCII text is pasted through the Android clipboard when the device supports its shell command.

## Lightweight test evidence

Recording defaults are tuned for quick test evidence: 480px maximum dimension, 1.5 Mbps bitrate, and a 30-second time limit. Use `record.mode: "always"` to keep a video for every run, or `"on_failure"` to keep a video only for failures. Failed recorded runs also save a screenshot, UI hierarchy XML when available, and recent logcat in the temporary MCP directory.

```json
{
  "steps": [{"action":"tap","x":540,"y":700},{"action":"assert_element","resourceId":"success_message","timeoutMs":5000}],
  "record": {"mode":"on_failure"}
}
```

To record outside a sequence, use `android_start_recording`. It accepts `maxSize`, `bitRate`, and `timeLimit`; for example `{"maxSize":480,"bitRate":1500000,"timeLimit":30}`.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-Model%20Context%20Protocol-8A2BE2)](https://modelcontextprotocol.io)

An MCP (Model Context Protocol) server that gives AI agents full control of Android devices and emulators through plain ADB — no companion APK, no extra daemon, no telemetry.

With this server, agents like Claude Code, Claude Desktop, or Cursor can **see** the screen (screenshots + UI hierarchy) and **act** on it (tap, swipe, type, launch apps, read logs, record video) on any device that `adb` can reach.

```
You: "Open Settings, turn on dark mode, and show me a screenshot"
Agent: launches the app, navigates by reading the UI hierarchy,
       taps the right elements, and returns a screenshot — hands-free.
```

## Why another Android MCP?

This project merges the best ideas of two excellent servers into one dependency-light TypeScript implementation:

| Inspiration | What was adopted |
|---|---|
| [mobile-mcp](https://github.com/mobile-next/mobile-mcp) | App management, uiautomator-based element listing, screenshots, screen recording, orientation control |
| [Android-MCP](https://github.com/CursorTouch/Android-MCP) | WiFi ADB + mDNS auto-discovery, selector-based taps, wait-for-element, smart default-device selection |

Differences by design:

- **ADB only.** No uiautomator2 server APK on the device, no `mobilecli` binary on the host.
- **Zero telemetry.** Nothing is phoned home, ever.
- **Android-first.** No iOS code paths to carry around.
- **Agent-friendly errors.** Failures return actionable messages that tell the agent what to try next.

## Requirements

- **Node.js 18+**
- **Android platform-tools** (`adb`) — auto-detected from `ANDROID_HOME`, `~/Library/Android/sdk` (macOS), or `%LOCALAPPDATA%\Android\Sdk` (Windows), with `PATH` as fallback
- An Android device with **USB debugging** or **wireless debugging** enabled, or a running **emulator**

## Installation

```bash
git clone https://github.com/nasiosheva/run-sequence-android-mcp.git
cd run-sequence-android-mcp
npm install
npm run build
```

### Claude Code

```bash
claude mcp add run-sequence-android -- node /path/to/run-sequence-android-mcp/dist/index.js
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "android": {
      "command": "node",
      "args": ["/path/to/run-sequence-android-mcp/dist/index.js"]
    }
  }
}
```

### Cursor / other MCP clients

Any client that speaks MCP over stdio works the same way: run `node /path/to/run-sequence-android-mcp/dist/index.js` as the server command.

### Environment variables (all optional)

| Variable | Purpose |
|---|---|
| `ANDROID_MCP_DEVICE` | Default device id used when a tool call omits `device` |
| `ANDROID_MCP_ALLOW_UNSAFE_URLS` | Set to `1` to allow non-http(s) URLs (e.g. deep links) in `android_open_url` |
| `ANDROID_MCP_FLOWS_PATH` | JSON file used to persist named automation flows |
| `ANDROID_HOME` | Android SDK location, used to locate `adb` |

## Device selection

Every tool accepts an optional `device` parameter. When omitted, the server resolves the target in this order:

1. `ANDROID_MCP_DEVICE` environment variable
2. The only online device, if exactly one is connected
3. The first **physical** device (USB or WiFi preferred over emulators)

`android_list_devices` also auto-connects wireless-debugging peers advertised via mDNS (`adb mdns services`) when the device list is empty — devices on the same network appear without any manual `adb connect`.

## Capabilities — 35 tools

### Test automation

| Tool | Description | Key parameters |
|---|---|---|
| `run_sequence` | Run a batched action sequence with selectors, assertions, variables, and optional recording. | `steps`, `variables?`, `record?` |
| `android_save_flow` | Save a named sequence for repeatable testing. | `name`, `steps`, `variables?` |
| `android_list_flows` | List saved sequences. | — |
| `android_run_flow` | Run a saved sequence with variable overrides and optional recording. | `name`, `variables?`, `record?` |
| `android_delete_flow` | Delete a saved sequence after confirmation. | `name`, `confirm: true` |
| `android_clear_saved_data` | Delete all saved flows and temporary MCP artifacts after confirmation. | `confirm: true` |

### Device management

| Tool | Description | Key parameters |
|---|---|---|
| `android_list_devices` | List connected devices with name, Android version, connection type (usb/wifi/emulator), and state. Auto-discovers mDNS wireless peers. | — |
| `android_connect_wifi` | Connect over WiFi ADB. Port defaults to 5555. | `host` |
| `android_device_info` | Model, Android version, SDK level, screen size, orientation, battery level, foreground app. | `device?` |

### App management

| Tool | Description | Key parameters |
|---|---|---|
| `android_list_apps` | List installed apps that have a launcher activity. | `device?` |
| `android_launch_app` | Launch an app by package name. | `packageName` |
| `android_terminate_app` | Force-stop a running app. | `packageName` |
| `android_install_app` | Install an APK, optionally granting all runtime permissions. | `apkPath`, `grantPermissions?` |
| `android_install_split_apps` | Install a base APK and split APK files together. | `apkPaths`, `grantPermissions?` |
| `android_clear_app_data` | Reset an app's local state after confirmation. | `packageName`, `confirm: true` |
| `android_uninstall_app` | Uninstall an app. | `packageName` |

### Screen observation

| Tool | Description | Key parameters |
|---|---|---|
| `android_take_screenshot` | Screenshot returned inline as an image the agent can see. | `device?` |
| `android_save_screenshot` | Screenshot saved to a local `.png` file. | `saveTo` |
| `android_list_elements` | UI hierarchy: element type, text, accessibility label, resource id, focus/clickable state, and center tap coordinates. | `device?` |
| `android_capture_state` | Save a screenshot and return the foreground app, UI elements, and recent logcat. | `device?`, `saveTo?` |
| `android_wait_for_element` | Poll until an element appears — use instead of fixed sleeps for dynamic content. | selector, `timeout?` |

### Interaction

| Tool | Description | Key parameters |
|---|---|---|
| `android_tap` | Tap at pixel coordinates. | `x`, `y` |
| `android_tap_element` | Find an element by selector and tap its center. Waits up to `timeout` (default 5 s) for it to appear. | selector, `index?`, `timeout?` |
| `android_double_tap` | Double-tap at coordinates. | `x`, `y` |
| `android_long_press` | Long-press at coordinates. | `x`, `y`, `duration?` |
| `android_swipe` | Directional swipe from screen center or from given coordinates. | `direction`, `x?`, `y?`, `distance?`, `duration?` |
| `android_drag` | Drag and drop between two points. | `fromX`, `fromY`, `toX`, `toY`, `duration?` |
| `android_type_text` | Type into the focused field, optionally clearing it first and/or submitting with ENTER. Non-ASCII text uses the Android clipboard when supported. | `text`, `submit?`, `clear?` |
| `android_press_key` | Press a key: `BACK`, `HOME`, `ENTER`, `APP_SWITCH`, `VOLUME_UP`, any `KEYCODE_*` name, or a numeric keycode. | `key` |
| `android_open_url` | Open an http(s) URL in the default browser. | `url` |
| `android_open_notifications` | Expand the notification shade. | `device?` |

### System

| Tool | Description | Key parameters |
|---|---|---|
| `android_set_orientation` | Force portrait/landscape (disables auto-rotate). | `orientation` |
| `android_start_recording` | Start lightweight background screen recording (480px, 1.5 Mbps, 30 s defaults; max 180 s). | `timeLimit?`, `maxSize?`, `bitRate?` |
| `android_stop_recording` | Stop recording, pull the `.mp4` to this computer. | `saveTo?` |
| `android_logcat` | Read recent logs with buffer selection (`main`/`system`/`crash`/`events`/`all`) and substring filter. Great for debugging Flutter/React Native crashes. | `lines?`, `buffer?`, `filter?` |

### Element selectors

`android_tap_element` and `android_wait_for_element` accept any combination of:

| Selector | Matching |
|---|---|
| `text` | Exact visible text |
| `textContains` | Substring of visible text, case-insensitive |
| `textRegex` | Visible text matching a JavaScript regular expression |
| `resourceId` | Full id (`com.app:id/btn_login`) or short id (`btn_login`, auto-expanded using the foreground app package) |
| `contentDesc` | Substring of accessibility label, case-insensitive |
| `contentDescExact` | Exact accessibility label / content description |
| `className` | Full class (`android.widget.Button`) or suffix (`Button`) |
| `clickable`, `enabled`, `focused`, `checked` | Exact element state |

## Usage examples

Prompts you can give an agent once the server is connected:

- *"List my devices and take a screenshot of the current screen."*
- *"Open the Settings app and toggle dark mode."*
- *"Install ~/Downloads/app-release.apk with all permissions granted, launch it, and check logcat for errors."*
- *"Fill in the login form: tap the field with resource id `email`, type `user@example.com`, then tap the Login button."*
- *"Record the screen while you walk through the onboarding flow, then save the video to my desktop."*
- *"My Flutter app crashed — read the crash buffer and tell me why."*

## How it works (spec)

```
┌──────────────┐   stdio (JSON-RPC / MCP)   ┌─────────────┐   adb CLI   ┌─────────────┐
│  MCP client   │ ◄────────────────────────► │ android-mcp │ ◄─────────► │   device /  │
│ (Claude, ...) │                            │  (Node.js)  │             │   emulator  │
└──────────────┘                            └─────────────┘             └─────────────┘
```

- **Transport:** stdio, stateless — one server process per client session.
- **Screenshots:** `adb exec-out screencap -p`, returned as PNG (inline base64 image or file).
- **UI hierarchy:** `adb exec-out uiautomator dump /dev/tty`, parsed with `fast-xml-parser`, retried up to 10× when the bridge returns a null root. Elements with no size or no useful text/id are filtered out.
- **Input:** `adb shell input` (tap/swipe/text/keyevent/draganddrop). ASCII text uses `input text`; non-ASCII text is set with `cmd clipboard set` and pasted with `KEYCODE_PASTE` when supported by the device.
- **Recording:** `adb shell screenrecord` is spawned in the background at 480px/1.5 Mbps by default. Stop sends `SIGINT` to the on-device process (`killall -2 screenrecord`), waits for the file to finalize, then `adb pull`s it. `run_sequence` can control recording automatically with `record.mode`.
- **Foreground app detection:** `dumpsys activity activities` (`ResumedActivity`, covering both pre- and post-Android-13 formats) with `dumpsys window` (`mFocusedApp`) as fallback.
- **Safety rails:** package names validated against `[a-zA-Z0-9_.]`, output paths must be absolute with allowed extensions, URLs restricted to http(s) unless explicitly overridden.

### Project layout

```
src/
├── index.ts    entry point — stdio transport
├── server.ts   MCP server + 26 tool registrations
├── adb.ts      adb discovery/execution, device resolution, WiFi + mDNS connect
└── ui.ts       uiautomator dump parsing, selector matching, wait-for-element
```

## Development

```bash
npm run watch      # rebuild on change
npm run inspector  # test tools interactively with MCP Inspector
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `adb not found` | Install Android platform-tools and/or set `ANDROID_HOME`. |
| `No Android devices connected` | Enable USB debugging (or wireless debugging), accept the RSA prompt on the device, check `adb devices`. |
| Screenshot is black | The screen is off — send `android_press_key` with `WAKEUP` first. |
| `Failed to dump UI hierarchy` | The foreground screen is secure (password field, DRM). Use `android_take_screenshot` instead. |
| Non-ASCII text fails | The device does not support the Android clipboard shell command. Use its keyboard or a compatible Android version. |
| WiFi connect fails | Ensure wireless debugging or `adb tcpip 5555` is active and the host is reachable. |

## Contributing

Issues and pull requests are welcome. Keep changes small and focused:

1. Fork and create a feature branch.
2. `npm run build` must pass with no TypeScript errors.
3. Verify against a real device or emulator where possible (MCP Inspector makes this easy).
4. Describe the behavior change in the PR.

## License

[MIT](LICENSE). This fork is maintained by Nasio Sheva ([@nasiosheva](https://github.com/nasiosheva)); the original copyright notice is retained in the license.
