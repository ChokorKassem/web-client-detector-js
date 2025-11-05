# Web Client Detector — README

## What this bot is (short intro)

This bot automatically isolates users who look suspicious (e.g. web-only clients) into a small verification area, forces them to verify **inside** a configured `#get-verified` channel (never by DM), and logs everything. Admins can scan members, export CSVs for large scans, manually verify/unsuspend users, change verification methods (button / typed word / math), and set the log channel. The bot is built for safe, paced role operations and robust error handling.

---

## Quick feature summary (TL;DR)

* Detects client platforms (desktop / mobile / web) using presence.
* Auto-creates and manages a `sus` role and channel permission overwrites.
* Single persistent verification message in your verify channel with a **Verify** button.
* Built-in verification methods: instant button, per-user word, math problem (mix/pick randomly).
* All verification inputs are ephemeral / modal-based (private) — no DMs.
* Commands: slash + prefix (`/scan`, `/autoscan`, `/verifyuser`, `/setupverify`, `/setlog`, `!unsus`, `!setlog`, etc.).
* Bulk scans + CSV export, paced role-ops to avoid rate limits.
* Immediate single mention when someone becomes sus (deleted automatically after 30s), and scheduled combined reminders at `:00` and `:30` (configurable).
* Logs structured data to a configurable log channel.

---

## Required Discord Developer Portal settings (exact)

1. Create your bot in the Developer Portal and copy the **Bot Token**, **Client ID** and **Guild ID** (server).
2. Under the bot's **Privileged Gateway Intents**, enable:

   * **Server Members Intent** (GUILD_MEMBERS)
   * **Presence Intent** (GUILD_PRESENCES)
   * If you want prefix commands to see message text, enable **Message Content Intent**.
3. When inviting the bot, include scopes:

   * `bot` and `applications.commands`
4. Give the bot these permissions (via the Invite URL builder or by selecting them):

   * **View Channels**
   * **Send Messages**
   * **Read Message History**
   * **Use Application Commands**
   * **Manage Roles** (required to add/remove the sus role)
   * **Manage Channels** (required to edit channel permission overwrites)
   * (Optional but recommended) **Manage Messages** (for housekeeping)

> Do **not** use Administrator unless you understand the security implications — give only the permissions above.

---

## Files & where to put them

* `index.js` — main bot (drop-in).
* `register-commands.js` — registers guild slash commands.
* `package.json` — dependencies & scripts.
* `.env` (create from `.env.example`) — your secrets and IDs.
* `config.json` — created automatically on first run (stores runtime settings).

---

## Exact setup steps (copy & paste)

1. Place the bot files in a folder on your machine/server.
2. Make a copy of the example env and edit it:

```bash
cp .env.example .env
# Open .env and fill:
# BOT_TOKEN, CLIENT_ID, GUILD_ID,
# VERIFY_CHANNEL_ID, SUS_CHAT_CHANNEL_ID, SUS_LOG_CHANNEL_ID,
# ADMIN_ROLE_IDS (JSON array)
```

3. Install dependencies (run in project folder):

```bash
npm install
```

4. Register slash commands (guild-scoped so they appear instantly):

```bash
node register-commands.js
```

5. Start the bot:

```bash
node index.js
```

6. Check the console: you should see `Logged in as <BotName#1234>` and `Ready — verification methods: ...`.

---

## How to test (step-by-step)

1. **Initial configuration**

   * In the verify channel (`VERIFY_CHANNEL_ID`), run `/setupverify` as an admin (one of `ADMIN_ROLE_IDS`).
   * Choose the method(s) you want. The bot will delete previous bot messages in the channel and post a single persistent verify message.

2. **Simulate a new join / sus assignment**

   * Use a test account or mark an existing user sus manually:

     * `/scan member:@user` → click **Mark sus** button,
     * OR use prefix `!unsus` flow in reverse by calling `!setlog` then manual marking (admins only).
   * Confirm: user gets `sus` role, the verify channel shows an immediate mention (deleted after ~30s), and logs appear in the log channel.

3. **Verify as the user**

   * As the sus user, open the verify channel and click **Verify**:

     * If **button-only** is enabled: verification completes immediately.
     * If **word/math** challenge: you will see a private prompt and a **Submit Answer** button — open the modal, the **question will be visible above the input** for mobile, submit correct answer → sus role removed, log entry created, ephemeral confirmation shown.

4. **Run a bulk scan**

   * `/scan` with no member option to scan whole server (be patient for large servers).
   * Use filters: `duration=last_day` or provide `start`/`end` ISO timestamps.
   * For large results the bot posts a CSV in the log channel.

5. **Periodic mention test (optional)**

   * For testing change `config.json` `periodicNotifyCron` to `* * * * *` (every minute), restart the bot, observe mentions, then restore cron (default `0,30 * * * *`).

---

## Required role/channel permissions & role hierarchy reminders

* **Bot role must be ABOVE the sus role** in server role hierarchy to add/remove it.
* Bot requires **Manage Roles** to add/remove roles and **Manage Channels** to set permission overwrites.
* Verify and sus chat channel IDs must be valid and the bot must be able to view/send in them.

---

## Troubleshooting (quick fixes)

* **“Interaction failed”**: ensure the bot is online and not hitting network timeouts; re-run `node register-commands.js` if slash commands are missing; check that the bot has `applications.commands` scope and required intents.
* **Presence empty / no platform found**: presence can be delayed or the user is offline — detection depends on Discord presence data.
* **Role ops fail**: check role hierarchy (bot role above sus role) and that bot has `Manage Roles`.
* **Connect timeout (UND_ERR_CONNECT_TIMEOUT)**: network issue; restart bot and retry. Retries are built into the code but persistent network problems need host networking fixes.

---

## Quick configuration tips

* `autoscan` is **OFF** by default. Enable via `/autoscan on` (admin).
* `config.json` persists runtime settings (verify message ID, log channel, methods). Manually editing is OK for testing, but prefer commands.
* To avoid over-notifying users, ask me to add a per-user throttle (e.g. max N mentions/day) and I’ll patch the bot.

---

## Final notes

* Everything is designed to keep verification **in-channel** (no DMs) and to be safe around Discord rate-limits.