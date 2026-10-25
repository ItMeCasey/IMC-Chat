# IMC-Chat

A Twitch chat client for Windows, in the same style as [IMC-Stream](https://github.com/ItMeCasey/IMC-Stream): a tray app with a local Node server (no dependencies) and a retro window. **Join any channel**, read and send chat, with tabs, emotes, replies and mention highlights. Free, GPL-3.0.

## Download
Get the Windows installer from the **[Releases page](https://github.com/ItMeCasey/IMC-Chat/releases)**: download `IMC-Chat.Setup.<version>.exe` from the newest release and run it. Each release also lists a `SHA256SUMS.txt` so you can check the download. The installer is not code-signed, so Windows may show a warning the first time (*More info* > *Run anyway*).

For the video player you will also want **VLC** (and, for Twitch's own player, nothing extra). The app can install **Streamlink** for you from Settings.

## Use it
1. Install and open IMC-Chat (or, to run it from the source, `cd app && npm install && npm start`).
2. Press **Connect Twitch**, open the link, type the code. The login works like Stream's (device code): the app never sees your password.
3. Type a channel name (or paste a twitch.tv link) in the box at the top and press **Join**. Each channel is a tab; a dot shows new messages (red = someone said your name).

## What is in the window
- **Chat:** emotes, Twitch badges (hover for the name), GIFs, replies, mention highlights, and the Twitch events: subs, resubs, gifts, raids, cheers, first messages and announcements (in their colour).
- **Emote picker** (smile button left of Send): every emote you can use in that channel in one searchable list: the channel's own, ones you own from other channels, Twitch's, and 7TV / BetterTTV / FrankerFaceZ, in tabs. 7TV, BTTV and FFZ emotes also show in the chat.
- **Tab completion** in the message box: `@` + Tab completes a recent chatter, a word + Tab completes an emote; Tab again for the next match, Shift+Tab for the previous.
- **Links** in chat open in your browser (hover for the site, and a preview for direct picture links). **Ctrl+F** finds in the current channel; a button jumps back to the latest when you have scrolled up.
- **Alerts:** your name, a reply to you, or one of your **highlight words** plays a chime, flashes the tab and (when the window is in the background) the taskbar button. Tabs show how many messages you missed. **Muted users and words** are hidden; alerts can be switched off per channel.
- **Connection:** the header shows *Reconnecting* when Twitch's chat connection drops and *App not responding* when the app itself does.
- **Watch:** hover a tab and press the play icon (or right-click it) to open a **popout**: the stream in Twitch's player with the chat beside it, or the chat alone. Prefer VLC or mpv? *Open in VLC* (right-click a tab, or the button in a popout) uses Streamlink to hand the stream to your player. **Settings > Video player** has a button that installs Streamlink with winget.
- **Our own player window (VLC):** the tab's play button opens a resizable window sized to the video, with VLC drawing the picture inside it and our own controls floating over the bottom of the video (play/pause, volume, quality, open chat, keep on top, fullscreen). The controls show while the mouse moves over the window and hide after a few seconds. The title strip and the controls follow the chat window's theme and font. Settings > Video player lets you choose this, a chromeless borderless player, or VLC/mpv's own window.
- **Twitch's own player:** right-click a tab > *Watch in Twitch's player* opens Twitch's real web player in a window of the app, with a browser profile of its own. Log in to Twitch there once (Settings > Twitch's own player, or just connect Twitch from the app, which opens its approval page in the same place) and Turbo or a subscription means no ads. The app never sees your password.
- **Right-click** a message (copy, reply, open the user, delete/timeout/ban for mods), a tab (popout, player, mute alerts, leave) or any text box (cut, copy, paste). Tabs show a LIVE tag with viewers and game.
- **Emote picker extras:** *Recent* and favourite (★) tabs; right-click an emote to favourite it. Up arrow in an empty box brings back what you sent; a counter shows the characters left near the 500 limit.
- **Recent messages (optional, off by default):** Settings > Chat can load the last messages when you join a channel, using the community service recent-messages.robotty.de (the channel name is sent to it).
- **Backup:** Settings > Backup exports your channels and settings to a file and imports them again (never your login).
- **Hover a name** for a card: picture, badges, account age, bio (and the moderator buttons where you are a moderator).
- **Tabs:** horizontal or vertical (settings), drag to reorder. Your channels, their order, the open tab and every setting are remembered between sessions.
- **Settings (gear):** font (IMC Sans, IMC Serif, IMC Dyslexia or your system font), size, weight (Thin to Black), and 9 themes: Forge, Midnight, Ember (dark), Dusk, Slate, Moss (mid), Cream, Paper, Sky (light).
- **Moderator tools:** in channels where you are a mod (and your own) the tab gets a sword. Hover a message to delete, timeout 10 minutes or ban; the name card has 1m/10m/1h/1d, ban and unban; the bar above the message box switches slow, followers, subs-only, emote-only and unique chat on and off, and clears the chat. Reconnect Twitch once after updating to grant the permissions.
- Twitch gives viewers no way to vote in polls or predictions from outside twitch.tv, and only a channel's owner can follow them, so IMC-Chat does not show them.

## Fonts
`_build/make_fonts.py` draws the three typefaces from stroke skeletons: nine weights each, upright and italic, with the Latin accents. Run it to rebuild `server/public/fonts/`.

## Where things are
- `server/twitch.js`: login, channels, one EventSub connection for all chats (tested by `node server/twitch-test.js`).
- `server/server.js`: the local server (port 8430, this PC only). `server/public/index.html`: the chat window.
- `app/`: the Electron shell (tray, window, restarts the server if it stops).
- Your login and channel list are in the app's data folder (tray menu: *Open my data folder*), never in the repository.

## Releases
A release is made by pushing a tag that matches the version in `app/package.json` (for example `v2026.10.4`): GitHub Actions runs the tests, builds the installer and attaches it, with checksums, to a **draft** release that you then publish from the Releases page. Bump the version first with `cd app && npm run bump`.

## Develop
```
npm install && npm run lint && npm test
cd app && npm install && npm start
```
