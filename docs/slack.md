# Slack

**Slack:** the teammates can talk in Slack, through one Slack app,
**Harmonia**. Click the **Slack bridge** light at the bottom left for a
step-by-step page: create the app from its manifest (one link sets up Socket
Mode, a bot you can DM, its scopes and its events), install it in your
workspace, make an app-level token with `connections:write`, and paste the
bot token (`xoxb-…`) and the app-level token (`xapp-…`) on the page.
Harmonia checks both with Slack and keeps them in your Keychain. The app
connects out over Slack's Socket Mode (`slack-socket.ts`), so nothing listens
on the internet; it works while Harmonia runs. The light is green when it's
connected and paired.
- **Pairing:** the page then shows a 6-digit code. Send it to the app in a
  Slack DM: whoever sends it is the one the teammates work for. **Pair
  someone else** makes a new code. After five wrong codes from one person,
  the app stops answering them.
- **Your DM** with the app mirrors the channel `#slack`: what you write there
  is posted as you, Mozart picks who answers (or `@Leo` goes straight to
  Leo), and the answers come back to the DM.
- **Channels:** `/invite @Harmonia` in a channel or private channel: it's
  linked to a new channel here (`#slack-<name>`) and asks for its project
  (below). One someone else added Harmonia to is linked the first time you
  write there. Each teammate answers under its own name and emoji
  (`chat:write.customize`: the avatar as a picture, Apple's emoji from
  `emoji-datasource-apple` on jsDelivr, so its skin tone shows as it does
  here; when the picture can't be had, the avatar's Slack emoji, else the
  avatar goes before the name). Without apps of their own (below), the
  teammates aren't Slack members, so Slack's @ menu doesn't list them: type
  `@Emily` in full, or start with `Emily, …`. Answers, job starts and errors
  go to Slack
  where you last wrote: in the channel, or in the thread you replied in; the
  5-minute job status updates stay here. The teammates' Markdown goes in a
  Slack markdown block. What you type in the app goes to Slack as "Alex (in
  Harmonia)". While a teammate works on your Slack message, a "typing…"
  message from it says so; it's deleted once the answer is out, and the
  answer comes as a new message (so Slack notifies you of it).
- **Teammates as Slack members:** on the Slack page, each teammate can get a
  Slack app of its own (a bot that posts and reacts, and that you can DM), so it's a member you can
  @mention from Slack's list, with its own profile. Generate an app
  configuration token (api.slack.com/apps → **Your App Configuration
  Tokens**) and paste it: Harmonia makes the apps (`apps.manifest.create`,
  scopes `chat:write`, `chat:write.customize` and `reactions:write`, plus
  `im:history`, `im:write`, `reactions:read`, `files:read` and `files:write`
  for your DM with it; Socket Mode, `message.im` and reaction events), sets each
  icon to the teammate's emoji (a 512 px picture the page draws,
  `apps.icon.set`), and doesn't keep the token. Then install each app and
  paste its bot token: Harmonia checks it's that app's, keeps it in the
  Keychain, and invites the bot to the linked channels (and to new ones).
  There, the teammate's answers and reactions go out from its own bot. Everything still
  comes in through the Harmonia app: `<@Emily's bot>` reads as `@Emily`.
  Cards with buttons (their clicks go to the Harmonia app), your DM with
  Harmonia and group DMs stay with Harmonia, under the teammate's name. A bot
  taken out of a channel is invited back; one whose token Slack stops taking
  (uninstalled) shows **Needs you**, and Harmonia posts for it meanwhile.
  Pasting a configuration token again updates the apps' names, descriptions,
  icons and scopes (after a rename, say; an app made before teammates reacted
  needs a reinstall after that, and Harmonia reacts for it until then); **Forget** drops one here (delete the app
  in Slack yourself).
- **DM a teammate in Slack:** **Let me DM Emily in Slack…** under a connected
  teammate takes an app-level token of its own app (Basic Information →
  App-Level Tokens, `connections:write`). Harmonia checks the token is that
  app's (the socket URL names its app) and that its bot token can read and
  open DMs (an app made before DMs needs the apps updated and a reinstall),
  keeps it in the Keychain, and listens on that app's own Socket Mode
  connection. Your Slack DM with Emily's app is then your DM with Emily here,
  linked as soon as both exist: your messages, thread replies, files and
  reactions come in over her socket, and everything in that DM goes out with
  her bot token (her answers, typing message, cards and their buttons, what
  you type in the app), since Harmonia's bot isn't in it. Someone else who
  DMs her app gets "I only work for …". **Turn off DMs** forgets the token;
  the DM here stays.
- **Voice messages:** record one in Slack (your DM with Harmonia or with a
  teammate, or a linked channel) and its words are your message, as if you'd
  typed them; the audio stays attached. macOS's own on-device dictation
  (macOS 26 and later) does it, so nothing leaves the Mac and there's nothing
  to set up: `voice.ts` runs the app's `harmonia-transcribe`
  (`macapp/transcribe.swift`). It tries each of the Mac's preferred languages
  and keeps the one it's surest of (`voiceLanguages` in `settings.json`, like
  `["he-IL", "en-US"]`, picks them instead). A WebM recording goes through
  ffmpeg when it's installed, or Slack's own MP4 copy of the clip. The
  teammates read it marked as a voice message, since dictation can mishear a
  word, and a voice message doesn't change the conversation's language: it
  goes on in the language the conversation (or its thread) started in. When
  the audio can't be made out, Harmonia says why in Slack.
- **Replies:** reply in a Slack thread to a message and it's a reply to that
  message here: a reply to a teammate goes to them, and
  the answers come back in the thread. A reply you type in the app goes in
  that message's Slack thread. Every message keeps its Slack ts
  (`meta.slack`) for this.
- **Reactions:** your reaction on a message in Slack is your reaction on it
  here, and taking it off takes it off (one at a time, as in the app; a
  custom emoji shows as `:name:`). Other people's reactions aren't read. A
  teammate's reaction (on your message or another teammate's) is a reaction
  in Slack too: from its
  own bot in a channel, from the Harmonia app in your DM and group DMs.
- **⚠️ feedback:** react ⚠️ to a teammate's message and Harmonia DMs you:
  "How can Leo's message be improved?", quoting it. Answer in that DM's
  thread, or press **Write feedback** for a box. Either way it's the same as
  ✎ in the app: a feedback job in which the teammate amends its rules. The
  feedback stays out of the Slack channel (shared channels have other people
  in them), and the job's card there says only that the teammate is
  amending its rules.
- **Requests with buttons:** when a teammate asks for a tool it doesn't have
  (a connector, through `request_tool`), its message in Slack has
  **Approve** / **Deny**; a permission card has **Allow once** / **Always in
  #channel** / **Deny**. Only your clicks count (anyone else gets a note only
  they see). Decide in Slack or in the app: the Slack message then says what
  you chose, without the buttons.
- **Only you wake the teammates.** Other people's messages in a linked
  channel show here as "Bob · in Slack", and the teammates and Mozart read
  them as context, but they never wake anyone: the teammates can read your
  mail and calendar. Only you can run the app's commands, and a DM from
  anyone else gets "Sorry, I only work for Alex."
- **New channels from Slack:** `@Harmonia new channel <name>` creates a Slack
  channel with you in it and links it to a new channel here; `@Harmonia new
  private channel <name>` (also `new group chat`) makes one only its members
  see. @mention people, or write their email, to invite them too. No admin
  needed, unless your workspace doesn't let apps create channels. In your DM
  with the app, leave out the `@Harmonia`. `@Harmonia help` lists the
  commands.
- **A project for each channel:** a new Slack channel (made with `new
  channel`, or one you `/invite` Harmonia to) opens with a list of your
  Claude projects: the folders your Claude Code sessions run in, as the Code
  tab in the Claude app groups them (read from its session records and
  `~/.claude/projects`). The teammates' bots join once you pick one, and
  what you write before that waits for them. The channel's folder becomes
  the project's, so the teammates' jobs, and their sessions in Claude, are
  there. The list stays in the channel to change it, and `@Harmonia project`
  brings it up again. In the app, New channel offers the same projects.
- **Status and archive from Slack:** `@Harmonia status <status>` sets the
  linked channel's status here (`in progress`, `waiting`, `later`,
  `archived` or `none`; `status` alone says what it is), and `@Harmonia
  archive` archives it.
- **Status and task in the topic:** in a Slack channel Harmonia made, the
  topic shows the channel's status and ClickUp task (`🔵 In progress ·
  ClickUp ABC-123`), and the task is a bookmark under the header. Slack
  can't badge channels in the sidebar, so that's where they show. A channel
  you brought Harmonia into keeps its own topic. The bookmark needs the
  `bookmarks:write` scope: an app made before it asks you to update it.
- **Every channel in Slack:** once the app is paired, a channel you make in
  the app gets a private Slack channel named after it, with you and the
  teammates' own bots in it. Archive a channel (here or from Slack) and it
  leaves Slack: a Slack channel Harmonia made is archived there (Slack
  doesn't let apps delete channels; it's renamed `<name>-archived-<date>`
  first, so the name is free again), and Harmonia leaves one you brought it
  into, since other people may use it. Unarchive it and it gets a new
  private Slack channel. Your DM with the app and group DMs can't go, so they
  stay linked.
- **Files:** a file on your Slack message (or on someone else's, in a
  linked channel) is fetched into the channel's attachments here
  (`files:read`), so it shows in the app and the teammates can open it. A
  Google Drive link or a file too big comes in as its name, with why. A
  file you attach in the app goes to Slack too (`files:write`): Slack posts
  a file message from the app itself, so it can't carry your name and
  picture the way your other messages do, and its comment starts with
  "Alex (in Harmonia)" instead. A thread reply on it in Slack is a reply to
  it here, as with any message. An app made before files is told so: your
  words still go, with the files' names, and a note here says what to update.
- Messages from Slack are read as text: mentions become `@Name`, and links
  their label and address. The Slack page lists the linked conversations, with **Unlink**.
  `slack.json` in the data folder holds the workspace, who the app works for,
  the links, the open ⚠️ questions and the teammates' apps; the tokens are in the Keychain
  (`Harmonia Slack`; off a Mac, `slack-secrets.json` in the data folder,
  readable only by you).
- **An app made from an older manifest** (before files, or reactions and
  buttons) is missing scopes: the Slack page notices and shows how to update it (paste
  the new manifest in the app's **App Manifest** page, then reinstall it).
