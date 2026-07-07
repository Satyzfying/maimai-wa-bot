# maimai-wa-bot

A WhatsApp bot built with Node.js that retrieves profile data, ratings, and play history (playlog) directly from the official **maimai DX NET** website (International and Japan servers).

---

## Features

- **Secure Login via Bookmarklet:** Links a maimai DX NET account using a JavaScript bookmarklet. The `.login` command is restricted to private chat only to protect session credentials.
- **Session Caching and Auto-Login:** Persists session cookies locally in `players.json` for fast single-request data retrieval. Automatically re-authenticates using the stored `clal` token when the session expires.
- **Rating Lookup (`.rating`):** Displays the player's current DX Rating and nickname.
- **Paginated Play History (`.recent`):** Navigates up to 5 pages of recent play history (25 tracks total) via `.recent page [1-5]`. Page switching is near-instant using an in-memory local cache.
- **Detailed Score Breakdown (`.recent [1-25]`):** Displays Fast/Late timing counts, Max Combo, Sync status, rating change, and a full judgement table (Tap, Hold, Slide, Touch, Break) formatted as a monospaced grid.
- **Song Constant Database:** Downloads the music database from the Diving Fish API on startup and uses it to resolve precise difficulty constants (e.g. `12.8` instead of level `12+`).
- **Multi-User and Group Support:** All user data is keyed by unique WhatsApp JID, allowing multiple users in a group to independently link and query their own accounts.

---

## Requirements

- Node.js v18 or later
- [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) — WhatsApp Web API library
- [ngrok](https://ngrok.com/) or equivalent — required to expose the local HTTP server for receiving bookmarklet login callbacks

---

## Installation

### 1. Clone the repository and install dependencies

```bash
npm install
```

### 2. Start an ngrok tunnel

The bot runs a local HTTP server on port 3000 to receive login data from the browser bookmarklet. Expose it with:

```bash
ngrok http 3000
```

Copy the generated HTTPS forwarding URL (e.g. `https://abcd-123-45.ngrok-free.dev`).

### 3. Configure the bot

Edit `config.json` in the project root:

```json
{
  "publicUrl": "https://your-ngrok-url.ngrok-free.dev",
  "port": 3000
}
```

---

## Running the Bot

```bash
node index.js
```

On first run, a QR code will appear in the terminal. Scan it using **Linked Devices** in the WhatsApp mobile app. Once connected, the bot is ready to accept commands.

To reset the WhatsApp session (e.g. after a 401 disconnect error), delete the session directory and restart:

```bash
rm -rf auth_info_baileys
node index.js
```

---

## Commands

| Command | Context | Description |
| :--- | :--- | :--- |
| `.login` | Private chat only | Initiates the maimai DX NET account linking flow. Generates a one-time OTP and bookmarklet instructions. |
| `.rating` | Private chat / Group | Displays the player's current DX Rating and nickname. |
| `.recent` | Private chat / Group | Displays the 5 most recent play records (page 1 of 5). |
| `.recent page [1-5]` | Private chat / Group | Navigates to the specified page of recent play history (5 tracks per page, up to 25 total). Shorthand: `.recent p [1-5]`. |
| `.recent [1-25]` | Private chat / Group | Displays the full score breakdown and judgement grid for the play record at the given index. |
| `.top` (or `.b50`) | Private chat / Group | Displays the player's Best 50 DX Rating (Best 15 new + Best 35 old). |
| `.top old [page]` | Private chat / Group | Displays the Best 35 (old songs) paginated. |
| `.top refresh` | Private chat / Group | Force-refreshes the Best 50 data from SEGA (bypasses local cache). |
| `.ping` | Private chat / Group | Checks bot uptime and responsiveness. |
| `.help` (or `.menu`) | Private chat / Group | Displays the help menu with all available commands and maintenance notes. |

---

## Project Structure

```
maimai-wa-bot/
├── commands/
│   ├── login.js       # Account linking flow
│   ├── ping.js        # Uptime check
│   ├── rating.js      # DX Rating lookup
│   └── recent.js      # Play history and score detail
├── utils/
│   ├── scraper.js     # HTTP scraper for maimai DX NET
│   └── music.js       # Song constant database loader (Diving Fish)
├── auth_info_baileys/ # WhatsApp session state (auto-generated, gitignored)
├── players.json       # Per-user account data (auto-generated, gitignored)
├── music_data.json    # Song database cache (auto-generated, gitignored)
├── config.json        # Bot configuration (publicUrl, port)
├── handler.js         # Message dispatcher and command router
└── index.js           # Entry point, WA socket, and HTTP server
```

---

## Security Notes

- The `.login` command is intentionally blocked in group chats to prevent the login URL and bookmarklet script from being exposed publicly, and to reduce the risk of the bot number being flagged for spam.
- All sensitive cookies (`clal`, session tokens) are stored locally on the hosting machine and are never transmitted to any third-party service.
