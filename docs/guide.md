# Pagewing user guide

The [README](../README.md) covers what Pagewing is, how to install it, and how you stay in control. This guide covers
the rest.

## How the agent works

pi gives the model tools for the tab you are on. The model looks at the page, acts, checks what happened, and repeats
until it can answer. Settings > Tools turns each tool Off or On; Act on page and Run script can also Ask, with a card in
the chat. Allow lets pi act on that site until the answer ends; **Allow for this chat** also covers the chat's later
answers there, until a new chat or Chrome closes. A script card shows the code, with Run, **For this answer**, and
**For this chat**:

| Tool | What it does | Default | Safe to replay |
| --- | --- | --- | --- |
| Read page | Reads the page's text, or only the selected part, and can wait for it to change (a video to reach a time, a text to show or go). | On | Yes |
| Observe page | Lists the links, buttons, fields, and headings, so pi can act on them. | On | Yes |
| Act on page | Clicks, types, presses keys, scrolls, picks options, and moves through the site and its tabs. | Ask | No |
| Run script | Runs JavaScript that pi writes, to pull data out of a page or compute over it. | Ask | No |
| Screenshot page | Captures the tab, or one part of it. | On | Yes |
| Console and network | Reads the tab's console messages and errors, and the address, method, and status of its requests. | On | Yes |

Screenshot page shows what is on screen, so the image may include what you typed into fields (Read page leaves that
out), and it goes to your model's provider. pi may scroll the page to the part it captures, also with Act on page Off.
Chrome lets pi capture a tab only after you open pi on that site with its toolbar button, menu, or shortcut, or on any
site when you allow pi on all sites (Settings > Advanced > Sites).

Console and network lets pi see why a page does not work: `Uncaught TypeError … (app.js:88)`, or
`POST /api/save → 403`. pi starts recording a tab when it first acts on it, runs a script there, or reads its console or
requests, so what happened before is not shown; a new page clears the console, a move to another site the requests.
Addresses lose their query, and pi never sees headers or content. The first time pi reads requests, a card asks
**pi asks to see the network requests of the tabs it uses**; Allow opens Chrome's prompt, once. The page can see that it
is being recorded.

Run script also needs Chrome's **Allow User Scripts** switch for pi, which is off for a new install. Setup asks for it
with a card after the provider (**Allow pi to run scripts (optional)**); Skip for now leaves Run script as it is, and
Settings > Tools links to the switch later. Until it is on, pi offers no scripts, and the model says so only when a task
needs one.

Safe to replay: if Chrome stops pi in the middle of the step, pi-durable runs it again, because running it twice does
no harm. A step that is not safe to replay is not repeated; the model is told it may have happened and to check the
page first (see [When Chrome stops pi](#when-chrome-stops-pi)). What the model is told about each tool, word for word,
is in [Page tools: what the model sees](page-tools.md).

- **You see every step.** Each read, click (with its reason), script (with its code), and screenshot shows in the chat,
  and an element pi clicks flashes a blue outline on the page. When pi has answered, the steps fold under one line,
  such as "12 steps" or "12 steps · 1 failed", so your question and the answer stand out; click it to see the steps,
  and a step to see what it did, its code, or its screenshot. A task that ended without an answer keeps its steps
  shown, with why a step failed. Stop, or Esc, ends the task; a script already running finishes first (at most 30 s). Messages you
  sent while pi was busy, and that had not started yet, come back as drafts under the message box.
- **It keeps working in the background.** Switch tabs or chats and the task goes on; several chats can work at once.
  A message sent while pi is busy joins the task after its current step (Enter), or waits for the answer (Alt+Enter);
  Settings > Sending swaps the two. Messages that wait go to pi together, in one turn, when the answer ends. Until pi reads it, a waiting message has two buttons: **Take back** returns its
  text to the drafts under the message box (not its attachments) while the task goes on, and **Send now** stops the
  answer, keeping the steps done so far, and sends the waiting messages at once, in the order you sent them.
  Ctrl+Enter (Cmd+Enter on a Mac) sends a new message the same way. If Chrome stops pi right after Send now, the
  messages stay waiting: click Send now again, or send any message.
- **Its reach is the tab group.** pi works on the attached tab and the other tabs in its Chrome group, or the tab alone
  if it is in no group. Tabs it opens join that group. Chats that share a group are not kept apart: one can change a
  page that another just read.
- **A step budget.** At most 50 tool calls per answer by default (5 to 200, in Settings > Tools).
- **Long tasks cost more.** What each step reads goes to the model. The line above the message box shows the cost as it
  grows.
- **Some sites resist.** A site that checks for real input ignores simulated clicks and keys, and pi cannot use file
  pickers or the clipboard. The steps show what happened.

## When Chrome stops pi

A Chrome extension's background code runs in a worker that Chrome may stop at any time: after about 30 seconds with
nothing happening, on a crash, or during an update, and everything in its memory goes with it. Pagewing is built on
[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) so that a task survives this:

1. **Every step is saved as it happens.** pi-durable writes your message, the running task, each tool call before it
   runs and its result after, and the answer being written (about every 100 ms) to the browser's database (IndexedDB).
2. **pi keeps the worker awake while it works.** During a task, pi makes a small Chrome call every 20 seconds, which
   usually keeps the worker alive.
3. **An alarm brings it back.** Before a task starts, pi sets a Chrome alarm. If the worker stops anyway, the alarm, or
   opening the panel, starts it again.
4. **The task carries on from its last saved step.** A request to the model that was in flight is sent again, and the
   provider bills it again. A click or a script that was in flight is not repeated blindly: the model is told it may or
   may not have happened, and to check the page before trying again; in the chat, that step says it was interrupted
   and may have partly run. Steps marked safe to replay in the table above, and listing tabs, simply run again. A step
   that Stop cut short says so too, and a click or a script adds that the page may already have changed: Stop does
   not undo it.
5. **Limits.** If the same task's worker stops a second time, pi stops it and shows "Interrupted" with Retry, so a page
   that keeps crashing pi cannot cause endless paid requests. After a browser restart, an unfinished task is not
   resumed: it shows "Interrupted", and nothing is sent.

## Setting up a provider

The setup card, or Settings > Providers, takes an API key for OpenAI, Anthropic, OpenRouter, or DeepSeek ("Get a key"
opens the provider's key page). After Save, Chrome asks you to let Pagewing reach that provider: allow it. Anthropic
takes API keys only, not a Claude subscription.

To use a ChatGPT plan instead of an OpenAI key, choose OpenAI, then "Continue with ChatGPT". Chrome asks for access to
OpenAI and to `127.0.0.1:1455`, the address OpenAI sends the sign-in back to; Pagewing catches it inside Chrome, and
removes that access when the sign-in ends. Sign in at OpenAI and click Continue.

### Update the model list

Pagewing comes with a list of each provider's models. When a provider adds a model after that, Settings > Models >
Update downloads the current list from pi.dev, the pi project's catalog, and the model picker lists the new models.
Nothing of yours is sent; the line below says when the list was last updated and how many models are new. In the
picker, a search that finds nothing links to the button.

## Asking about a page

Select text on a page and right-click "Ask pi", or press `Ctrl+Shift+Y`. With nothing selected, right-click the page:
"Ask pi about this page" attaches it, and a prompt such as "Summarize" sends with the page attached.
`Settings > Sending > Ask pi` chooses whether "Ask pi" sends at once or puts the question in the message box to edit
first.

## Images and text files

Paste an image into the message box, drop images or files on the panel, or click the paperclip. A message can carry up
to 10 of them, and can be only images or files with no text.

- **Images** (PNG, JPEG, GIF, WebP, and others Chrome can show) are made at most 1280 pixels on the long side, turned
  upright, and sent as PNG, or as JPEG if that is too large; an animated GIF sends its first frame. HEIC photos are
  refused: convert them first. The chip shows the size that is sent.
- **Text files** are sent as text: code, CSV, Markdown, JSON, logs, and other UTF-8 files, up to 100,000 characters
  each and 200,000 in all. PDF, Word, Excel, and other documents are refused: copy their text, or save them as CSV or
  plain text.
- A paste with text in it pastes the text, also when it has an image of it too: copy an image alone to attach it.
- Images need a model that can see them; pi says so before sending. pi keeps a chat to about 20 images per request,
  screenshots included, and refuses more. If you switch a chat to a model that cannot see images, its earlier images are sent as a note
  that an image was there: that model cannot see them.
- Large files fill the model's context fast. If a provider says the request is too long, send fewer or shorter files,
  or choose a model with a larger context.
- Edit keeps a message's attachments; ✕ leaves one out. Stop and Take back do not keep the attachments of a message
  they take off the queue, and say so; Send now keeps them. Export lists their names only.

## Chats and History

Each tab has its own chat, and keeps it while you follow links or reload. When pi first opens in a tab, it continues
the newest chat that started on the same page, if there is one. New chat starts over in the same tab. History lists
earlier chats; a chat's ⋯ menu renames it, exports it as Markdown, or removes it from History. Removing hides the chat;
its data stays stored, since Pagewing cannot delete a single chat. Settings > Advanced > Data > Delete all chats erases
them all, and keeps your settings, keys, and sign-in.

## Prompts

The built-in prompts are Explain, Summarize, Translate, Proofread, and Draft a reply. Settings > Prompts edits them,
adds your own, orders them in the right-click menu, and stars the one "Ask pi" uses. Every prompt is in the menu both
for selected text and for the page. The switch at the end of a prompt's row turns it off: it leaves the menu and the
`/` list but stays in Settings, ready to turn on again. The starred prompt stays on. Delete removes a prompt, also a
built-in one; Reset to built-in prompts brings the built-in ones back and deletes your changes and the prompts you
added. A prompt can ask a question or set a task, as in [the prompt recipes](prompts.md).

A prompt puts the selected text where it says `{{selection}}` (or the whole page, with nothing selected), the page's
title and address where it says `{{title}}` and `{{url}}`, and the answer language where it says `{{language}}`.

## Slash commands

Type `/` in the message box for a list of your prompts. `/summarize` alone runs the prompt for the attached page;
`/explain some text` runs it for the text after the name. Built-in prompts are `/explain`, `/summarize`, `/translate`,
`/proofread`, and `/reply` in every language; your own prompts use their name, lowercase with dashes (`/explain-code`,
`/translate-in-page`).

## Models and thinking

The model chip in the message box picks the model, from every provider you have set up. The bulb sets how long a model
that can think does so. New installations start at Medium; a level you chose, Off included, is kept. Longer thinking
can help with hard questions and longer tasks, but answers start later and cost more; lower levels can reduce delay and
cost, depending on the model. On a model that cannot turn thinking off, Off uses the provider's default. For tasks,
choose a model that is good at using tools; small models can lose their way. The line above the message box shows the
chat's tokens, estimated cost, and how full the model's context is; near the limit, pi summarizes older messages by
itself.

## Editing a question

Under a question you sent, Copy copies its text and Edit lets you change it and send it again. The edit goes to a new
chat that has everything before that question, so the model never sees the old one or its answer; the original chat
stays in History, and "Open original" goes back to it. Edit waits until the answer is done. It does not undo what pi
did on pages.

## Answers and diagrams

Copy puts an answer's Markdown on the clipboard; the icon after it shows the answer's usage. A ` ```mermaid ` block
shows as a picture once it is complete: any diagram type built into Mermaid, such as flowcharts, sequence, state,
class, ER, gantt, pie, and mindmap diagrams. Click it for full size; "Source" shows its code. Other diagram types (such
as zenuml), and diagrams too large or slow to draw, stay code. Pictures
are drawn on your machine and load nothing from the network.

## OpenAI web search

Settings > Providers > OpenAI > Web search, On by default, lets OpenAI models search the web when needed, with an API
key or a ChatGPT plan. Citations show as numbered links. With an API key, searches cost extra, and the cost estimate
does not include them. Turn it Off if OpenAI refuses it for your model or account.

## Shortcuts

| Shortcut | What it does |
| --- | --- |
| `Ctrl+Shift+U` / `Cmd+Shift+U` | Open the side panel. |
| `Ctrl+Shift+Y` / `Cmd+Shift+Y` | Ask pi about the selected text, with the starred prompt. |
| `Ctrl+Shift+K` / `Cmd+Shift+K` | Add the selected text to the message box, to write your own question. |

Change them at `chrome://extensions/shortcuts`. Chrome leaves a shortcut unset when another extension has it (Settings
> Advanced > Shortcuts then shows "Not set").

In the message box, Enter sends and Shift+Enter starts a new line. While pi works, Alt+Enter sends the other way than
Enter (join the task or wait for the answer), and Ctrl+Enter (Cmd+Enter on a Mac) stops the answer and sends the
message now ([How the agent works](#how-the-agent-works)). These keys are fixed.

## Languages

The interface follows Chrome's language: English or Simplified Chinese; other languages fall back to English. Restart
Chrome after changing its language. Settings > Answers > Answer language sets the language of answers and the
Translate target only: "Auto (Chrome language)" by default, or English or Chinese. Proofread keeps the text's own
language, and Draft a reply uses the original's.

## Settings

Open Settings with the button at the top of the panel. The defaults below are those of a new installation.

| Part | What it sets | Default |
| --- | --- | --- |
| Providers | API keys and the ChatGPT sign-in ([Setting up a provider](#setting-up-a-provider)), and OpenAI's [web search](#openai-web-search) | No API key or ChatGPT sign-in; web search On |
| Models | The model list: Update downloads the current one ([Update the model list](#update-the-model-list)) | The list that came with Pagewing |
| Answers | Answer language, also the Translate target ([Languages](#languages)) | Auto (Chrome language) |
| Sending | **Ask pi**: Send at once or Edit first ([Asking about a page](#asking-about-a-page)). **While pi works**: what Enter does with a message, Join the task or Wait; Alt+Enter does the other, Ctrl+Enter sends now ([How the agent works](#how-the-agent-works)) | Send at once; Join the task |
| Prompts | The right-click menu and the `/` list: edit, add, delete, reorder, star, switch off, reset ([Prompts](#prompts)) | The 5 built-in prompts, all on, Explain starred |
| Tools | Read page, Observe page, Screenshot page, Console and network: Off or On. Act on page, Run script: Off, Ask, or On. Page tool calls per answer, 5 to 200 ([How the agent works](#how-the-agent-works)) | Read page, Observe page, Screenshot page, Console and network On; Act on page, Run script Ask; 50 calls |
| Advanced > Sites | The sites pi uses without asking: remove one, or Allow all sites ([Sites](#sites)) | None |
| Advanced > Shortcuts | Shows the current shortcuts, and opens Chrome's page to change them ([Shortcuts](#shortcuts)) | - |
| Advanced > Diagnostics | Opens the extension's status, test probes, and log ([Diagnostics](#diagnostics)) | - |
| Advanced > Data | Delete all chats; settings, keys, and sign-in stay ([Chats and History](#chats-and-history)) | - |

The model and the thinking level are not in Settings: they are in the message box ([Models and
thinking](#models-and-thinking)). Run script also needs Chrome's own Allow User Scripts switch, which is off for a new
installation ([How the agent works](#how-the-agent-works)).

### Sites

pi reads the page you open it on. For any other page it needs Chrome's access to the site:

- **Always allow pi on a site.** The pin button on the page chip in the message box lets pi read that site's pages
  without a click, also after you leave and come back. Chrome may ask first.
- **During a task.** When pi needs a site it has no access to, a card in the chat asks you first.
- **Settings > Advanced > Sites** lists the sites pi uses without asking. Remove revokes that grant, not other grants
  that cover the same site: while all sites are allowed, pi can still reach it. What pi already read stays in the
  chat. **Allow all sites** asks Chrome for every site at once. The list also shows the sites pi can reach because of
  your providers.

Site access is only about reading and reaching pages. Whether pi may click, type, or run scripts there is still set
by Settings > Tools: in Ask, pi asks before it acts.

### Diagnostics

Settings > Advanced > Diagnostics opens a page with the extension's status, test probes, and its log. Open it when you
report a problem.

## Storage

- Chats, settings, and prompts stay in your Chrome profile. Chats keep what pi read from pages and what the page tools
  returned, until you delete all chats. Removing the extension deletes everything it stored.
- API keys and ChatGPT sign-in tokens are stored unencrypted in the Chrome profile (`chrome.storage.local`). Web pages
  cannot read them; programs running as you, or anyone with your profile's files, can.
- Messages you have not sent yet are kept only until the browser closes or the extension reloads.
- If Chrome has no room left to save chats, a banner in the panel says so: free up disk space, or delete all chats.
  Pagewing does not delete old chats by itself.
- The full policy is in [PRIVACY.md](../PRIVACY.md).

## Limits

- Pagewing does not run in incognito windows.
- pi cannot read Chrome's own pages, the Chrome Web Store, or the PDF viewer.
- A task interrupted by Chrome is resumed once at most ([When Chrome stops pi](#when-chrome-stops-pi)).
