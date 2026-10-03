## Download SlopBot {{VERSION}}

| Your computer | Download | Then |
| --- | --- | --- |
| **Mac with Apple Silicon** (M1 and newer) | `SlopBot-{{VERSION}}-mac-arm64.dmg` | Open it and drag SlopBot to Applications |
| **Mac with Intel** | `SlopBot-{{VERSION}}-mac-x64.dmg` | Open it and drag SlopBot to Applications |
| **Windows 10/11** | `SlopBot-{{VERSION}}-windows-x64-setup.exe` | Run the installer |
| **Windows (no install)** | `SlopBot-{{VERSION}}-windows-x64.zip` | Unzip, run `SlopBot.exe` |
| **Linux** (any distro) | `SlopBot-{{VERSION}}-linux-x86_64.AppImage` | `chmod +x` it, then run it |
| **Debian / Ubuntu** | `SlopBot-{{VERSION}}-linux-amd64.deb` | `sudo apt install ./SlopBot-{{VERSION}}-linux-amd64.deb` |

Not sure which Mac you have?  → About This Mac. "Chip: Apple M…" means Apple Silicon.

### First launch

These builds may not be code-signed yet, so your system may warn you the first time:

- **macOS:** "SlopBot can't be opened because it's from an unidentified developer". Right-click (or Control-click) SlopBot in Applications → **Open** → **Open**. Or: System Settings → Privacy & Security → **Open Anyway**.
- **Windows:** "Windows protected your PC". Click **More info** → **Run anyway**.

Then pick a model: open **Models** to download a free local one with Ollama, or add an API key. The full guide is in the [README](https://github.com/CameronWDavis/SlopBot#getting-started).

Verify your download with `SHA256SUMS.txt` (`shasum -a 256 <file>` on macOS/Linux, `Get-FileHash <file>` on Windows).
