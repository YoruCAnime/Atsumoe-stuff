# Atsumoe stuff

Plugins for [atsu.moe](https://atsu.moe). Install [Tampermonkey](https://www.tampermonkey.net/) first, then click an install link.

| Plugin | What it does | Install |
|---|---|---|
| **Voice Reader** | Voiced manga and manhwa reader: speech bubbles read aloud | [install](https://raw.githubusercontent.com/YoruCAnime/Atsumoe-stuff/main/voice-reader/atsu-voice-reader.user.js) + setup below |
| **AniList Tracker** | AniList tracker for the mobile Firefox browser: updates your AniList at 85% of a chapter | [install](https://raw.githubusercontent.com/YoruCAnime/Atsumoe-stuff/main/anilist-tracker/atsu-anilist-tracker.user.js) + steps below |
| Comfy Reader | Smooth arrow-key scrolling | [install](https://raw.githubusercontent.com/YoruCAnime/Anime-site-scripts/main/atsumoe/atsu-comfy-reader.user.js) |
| Next Chapters | New-chapter countdown on the home page | [install](https://raw.githubusercontent.com/YoruCAnime/Anime-site-scripts/main/atsumoe/atsu-next-chapters.user.js) |

## Voice Reader

A voiced manga reader. It finds the bubbles, skips sound effects and credits, guesses who is speaking, and pauses auto-scroll while a line is read. Manga is read right to left. Everything runs on your own PC.

Early and still improving: expect some wrong voices and misread words.

**You need:** Windows, an NVIDIA graphics card (8 GB is fine), [Python 3.11](https://www.python.org/downloads/release/python-3119/) and [ffmpeg](https://ffmpeg.org/download.html) on your PATH.

**Setup** (in `voice-reader/helper`, after [downloading this repo](https://github.com/YoruCAnime/Atsumoe-stuff/archive/refs/heads/main.zip)):

1. Run `1 - Setup (run once).bat` (downloads about 6 GB).
2. Run `2 - Install helper (start with Windows).bat`.
3. Install the [userscript](https://raw.githubusercontent.com/YoruCAnime/Atsumoe-stuff/main/voice-reader/atsu-voice-reader.user.js).

**Use:** open a chapter and press **V**. A small speaker icon sits bottom right: hover it for progress and the settings gear.

**No waiting:** on a manga's page, click **Voices** (bottom right) to get its chapters ready ahead. It starts after your last read chapter, in the group you read. While you read, the next chapters get ready too, and finished ones are deleted.

| Key | |
|---|---|
| V | Voice on / off |
| K | atsu's auto-scroll |
| B | Other voice for the last line |

**Custom voices (optional):** run `Setup My voice (optional).bat`, then `Voice Maker.bat`. Only use voices you have permission to use.

**To remove it:** run `Remove helper from Windows start.bat`.

Built on [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), [Chatterbox](https://github.com/resemble-ai/chatterbox), [RapidOCR](https://github.com/RapidAI/RapidOCR), [imgutils](https://github.com/deepghs/imgutils), [CLIP](https://github.com/openai/CLIP) and [Whisper](https://github.com/openai/whisper).

## AniList Tracker

AniList tracker for the mobile Firefox browser, by YoruC. A thin line along the bottom of the reader shows how far you have read, and at 85% of a chapter your AniList goes up by itself. Tap the line to update by hand, undo, fix the series match or change the settings.

> [!TIP]
> **Install on your phone**
> 1. Get [Firefox](https://play.google.com/store/apps/details?id=org.mozilla.firefox) from the Play Store.
> 2. In Firefox, open [Tampermonkey](https://addons.mozilla.org/addon/tampermonkey/) and tap **Add to Firefox**.
> 3. In Firefox, open the [install link](https://raw.githubusercontent.com/YoruCAnime/Atsumoe-stuff/main/anilist-tracker/atsu-anilist-tracker.user.js) and tap **Install**.
> 4. Open a chapter, scroll a little, tap **! Connect AL** at the bottom left and follow the steps (one time).

Your AniList login stays in Tampermonkey on your phone. atsu's own AniList sync can stay on: chapters AniList already has are skipped.
