# CHECKLIST — First manual run‑through (exact clicks)

This is a short, exact list of what to *click* during your first manual test. Follow steps in order.

---

## 1) Before you start (one-time)
- Open the server in Discord where the bot is invited.
- Make sure you (the tester) have an admin role listed in `ADMIN_ROLE_IDS`.
- Ensure the bot is online (console shows `Logged in as <BotName#1234>`).

---

## 2) Register commands & open verify channel
1. In your shell / terminal: **click** or run `node register-commands.js` (once) — this registers slash commands in the guild.
2. Start the bot: **click** or run `node index.js`.
3. In Discord: **click** the configured verify channel (the channel ID you put in `VERIFY_CHANNEL_ID`).

---

## 3) Interactive setup (admin) — exactly what to click
1. In the verify channel, **type** or trigger the slash command: `/setupverify` → **press Enter**.
2. A short ephemeral reply appears; the bot will open an interactive setup message in the same verify channel. In that message:
   - **Click** the select menu labeled `Select verification methods` to open it.
   - **Click** to choose 1 or more methods (examples shown: `Quick Verify Button`, `Per-user typed word`, `Math problem`). You can multi-select.
   - **Click** the green **Confirm** button.
3. When Confirm runs the bot will:
   - Delete its previous verify messages, then **post one new persistent verify message** in this verify channel.
   - The setup dialog confirms success (ephemeral). Close that.

---

## 4) Verify message — what a sus user will see and click
1. In the verify channel locate the persistent message titled: **Server Verification — click Verify below to begin**.
2. The sus user (or you testing as the sus user) should **click** the **Verify** button on that message.
   - If the enabled method is **button-only**, verification completes immediately and you will see an ephemeral confirmation.
   - If the enabled methods include **word** or **math**, the bot will reply *ephemerally* with a private prompt and a **Submit Answer** button.
3. If you see the **Submit Answer** button: **click** it (ephemeral reply shows it).
   - A modal will open. Above the answer input the modal’s label will show the question (the word or math expression).
   - **Click** the answer input field, **type** the exact word or the numeric answer, then **click** the modal’s **Submit** button.
4. After a correct submission you will see an ephemeral confirmation: you are verified and the sus role is removed.

---

## 5) Mark a member sus (admin test) — exact clicks
1. In any text channel (or the verify channel), **type** the slash command: `/scan member:@User` and press **Enter** (choose a test user from the picker).
2. The bot replies with a scan embed and two buttons: **Mark sus** (red) and **Ignore** (grey).
3. **Click** the **Mark sus** button.
   - The bot will add the sus role to that user, post an immediate mention in the verify channel (auto-deletes after ~30s), and log the action to the log channel.

---

## 6) Manual verify (admin) — exact clicks
1. As admin, run the slash command `/verifyuser member:@User` → press **Enter**.
2. The bot replies ephemeral: sus removed and a log entry is written.

---

## 7) Change log channel (admin) — exact clicks
1. Run slash command `/setlog channel:#logs` (use the channel picker) → press **Enter**.
2. The bot replies ephemeral confirming the log channel is set.

---

## 8) Quick check of periodic mentions (optional test)
> Only for testing — restore normal cron after.
1. (Temporarily) edit `config.json`’s `periodicNotifyCron` to `* * * * *` then restart the bot.
2. Wait one minute and watch the verify channel for the combined mention messages (they will delete after ~30s).
3. When done, restore `periodicNotifyCron` to the original `0,30 * * * *` and restart.

---

## 9) If something fails — what to click / check immediately
- If a button click shows “This interaction failed”: **click** the bot’s persistent verify message once more, then retry the button. If problem persists: restart the bot (stop then **click** `node index.js` again) and re-run `/setupverify`.
- If role ops fail: open Server Settings → Roles, then **click and drag** the bot role above the sus role in the role list, then restart the bot.

---

## Final note (keep this handy)
- During your first run, the only UI elements you must click in Discord are:
  - `/setupverify` (slash) → select menu → **Confirm**
  - Persistent message **Verify** button
  - **Submit Answer** (if challenge) → modal **Submit**
  - `/scan member:@User` → **Mark sus** button
  - `/setlog channel:#channel` (if you need to set logs)