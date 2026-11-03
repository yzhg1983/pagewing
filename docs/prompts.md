# Prompt recipes

English | [简体中文](prompts.zh-CN.md)

A prompt can set a whole task, scripts included. Add one in Settings > Prompts, and it shows in the right-click menu
and as a `/command`. Both prompts below run scripts, so they need Allow User Scripts
([Quick start](../README.md#quick-start), step 5); choose **For this chat** on the script card, or set Run script to On,
to skip the card next time.

## Translate a page in place

Translation extensions usually send a page to a translation service piece by piece, so the same name or term can come
back translated three different ways. With this prompt, the model reads the whole page and translates it as one text,
then a script puts each translated paragraph under its original on the page.

Add it as "Translate in page", then right-click any article and choose **Translate in page**. `{{selection}}` is the
whole page when nothing is selected; select a few paragraphs first to translate only those. `{{language}}` is your
answer language (Settings > Answers).

<details>
<summary>The prompt</summary>

```text
Translate the text below into {{language}}, then embed the translation back into the original page, paragraph by paragraph: each translated paragraph right below its original. Keep the original text.

Style each translation like its original: the same kind of element (a heading stays a heading, a list item a list item) with the same classes, but without its id. Add no border, vertical line, quote formatting, background color, or other decoration that the original does not have.

{{selection}}
```

</details>

It is slower than a translation extension, but the translation reads as one piece, and with a ChatGPT plan it runs on
your plan instead of a per-token bill. A higher thinking level (the bulb in the message box) can give a more careful
translation, at the cost of more time.

## Summarize a YouTube video

pi reads the video's full captions with one script, without opening the transcript panel, and answers from them. By
default it writes a summary: the main points first, then chapters. Click a chapter's timestamp and the video in the tab
jumps to that moment, without reloading the page. To catch the player's caption request, the script may turn captions
off and on once; it leaves them as they were.

Add it as "Summarize video". On a video, right-click the page and choose **Summarize video**, or type
`/summarize-video`. A question after the command replaces the summary: `/summarize-video what does she say about
pricing?`

<details>
<summary>The prompt</summary>

```text
First check the tab's URL: {{url}}
If it is not a YouTube video page (www., m. or music.youtube.com with /watch?v= or /shorts/ followed by an ID), reply only with "Open a YouTube video in this tab, then run this again." in {{language}}, and stop: call no tools.
Otherwise, get the full captions of that video with run_script, then do this task from them: {{selection}}
If the task is empty or only says the whole page is attached, summarize the video. Do not use the "Show transcript" panel. Any caption language is fine.
Write ONE script that does all of this, read-only except for step 3:

1. Video ID from ?v= or the path after /shorts/; none: return {notVideo: true} and stop. If globalThis.piCaptions?.videoId is that ID, skip to step 6.
2. A caption request is usable if its URL contains "/api/timedtext" and "v=" + the ID, and its expire parameter (Unix seconds) is in the future. Look for the newest usable one in performance.getEntriesByType("resource").
3. If none (that buffer is often full or stale): start a PerformanceObserver with observe({type: "resource"}) that collects usable URLs; note whether .ytp-subtitles-button has aria-pressed="true"; if it was on, click it off and wait 300 ms; click it on; wait up to 6 s for a usable URL; disconnect; click again if needed so CC ends in the state you noted.
4. No usable URL: if the observer saw only expired ones, return {stalePlayer: true, toggledCC}; else return {capturedRequest: false, toggledCC}. Stop.
5. Take the usable URL, set fmt=json3, delete tlang, fetch it. Parse json3: for each event in events with segs, text = its segs' utf8 joined, trimmed; skip empty. Line = "[h:mm:ss] text" from tStartMs. Store globalThis.piCaptions = {videoId, language: the URL's lang, auto: kind === "asr", lines}. Empty or non-JSON body: return {status, bytes, hasPot: whether the URL has pot, toggledCC} and stop.
6. Return {videoId, language, auto, totalLines, from, to, toggledCC, text}, where text is lines from `from` joined by "\n", stopping before 30,000 characters.

Rules:
* Never return, log, or repeat the caption URL or any of its parameter values (signature, pot, ei, …).
* notVideo: give the same one-line reply as above. stalePlayer: tell me to reload the tab and try again. Other failures: report the returned fields. Do not guess captions.
* Video too long for one result: run short follow-up scripts that only read globalThis.piCaptions and return the next slice, until you have what the task needs. Do not fetch again.

How to write the answer (unless the task asks for another form). Readers scan, so put the point first:
* Start with "**In short:**" and one sentence on what the video is and who speaks, then 3–5 bullets with its main conclusions, most important first.
* Then "## Chapters", in order. Each heading: "### [12:34](LINK) " + the point as a short statement, e.g. "Open models let countries run their own AI", not a bare topic like "Open models". LINK is the tab's URL above, unchanged except t set to the start in seconds (t=754s), replacing any t it has. Under it, 1–3 bullets, one idea each, under 25 words, starting with who says it ("Huang:") when there are several speakers. Add the example or number that makes the point concrete. Where speakers disagree, give each side its own bullet. 5–10 chapters for an hour; merge topics that come back.
* Plain words, short sentences; explain a term once if the speakers rely on it. Report claims as the speaker's ("he argues"), without judging them. Keep names and titles as spoken; quote at most a short phrase. No tables, nested bullets, emoji, or filler such as "In this section". Bold at most one key phrase per chapter.
* End with "**Worth watching:**" 1–3 timestamp links to the parts most worth seeing in full, each with a few words on why.

Answer in {{language}}.
```

</details>
