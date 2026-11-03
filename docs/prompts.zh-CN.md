# 提示词示例

[English](prompts.md) | 简体中文

一条提示词可以交代一整件任务，连脚本一起。在 设置 > 提示词 里添加后，它会出现在右键菜单里，也能用 `/命令` 调用。下面两条提示词都要运行脚本，所以需要先开启“允许用户脚本”（见[快速上手](../README.zh-CN.md#快速上手)第 5 步）；在脚本卡片上选 **本次对话**，或者把“运行脚本”设为开启，下次就不用再确认。

## 页面内翻译

常见的翻译插件会把网页拆成一段一段分别送去翻译，结果同一个人名或术语，前后可能出现三种译法。这条提示词换了个做法：先让模型通读整页、当作一篇文章来翻，再用脚本把每段译文插到对应原文的正下方。

添加一条提示词，命名为“页面内翻译”，之后在任意文章上右键，选 **页面内翻译** 即可。没有选中文字时，`{{selection}}` 就是整个页面；先选中几段，就只翻译这几段。想译成别的语言，把“中文”换掉就行。

<details>
<summary>提示词全文</summary>

```text
把下面的内容译成中文，再逐段放回原网页：每段译文紧跟在对应的原文段落下方，保留原文。

译文沿用对应原文的样式：用同一种元素（标题仍是标题，列表项仍是列表项），带上相同的 class，但不要复制 id。不要另加原文没有的左边框、竖线、引用样式、背景色或其他装饰。

{{selection}}
```

</details>

它比翻译插件慢，但译文前后统一，读起来连贯；用 ChatGPT 订阅时，走的是套餐额度，不按 token 计费。把输入框里的“思考”档位（灯泡图标）调高，译文会更用心，只是要多等一会儿。

## YouTube 视频总结

pi 用一段脚本读出视频的完整字幕（不用打开“显示文字记录”面板），再根据字幕作答。默认会写一份总结：先列要点，再按章节展开。点章节里的时间戳，标签页里的视频会直接跳到那一刻，不用刷新页面。为了截到播放器的字幕请求，脚本可能会把字幕关掉再打开一次，结束时恢复原样。

添加一条提示词，命名为“视频总结”。打开一个视频，在页面上右键选 **视频总结**，或者输入 `/视频总结`。命令后面跟一个问题，就会改为回答这个问题，比如 `/视频总结 她对定价怎么看？`。提示词是英文写的，回答语言跟随 设置 > 回答。

<details>
<summary>提示词全文</summary>

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
