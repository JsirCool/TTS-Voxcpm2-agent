# Bilibili Intro Video Script / B 站介绍视频文案

## Goal

- Title: `《我偷走了B站所有人的声音》`
- Cover subtitle: `但我真正做出来的，是一整套本地配音工作流`
- Runtime target: `3分30秒 - 3分50秒`
- Narrator persona: `我做了一个项目`
- Primary subject: `tts-agent-harness`
- Supporting model layer: `VoxCPM2`

This script is written for a `Bilibili tech-zone` style intro video with `voice-over + screen recording`.
It is not framed as a review or third-party experience.
The tone should stay in a builder perspective:

- `我这段时间做了一个项目`
- `我想解决的问题是`
- `我不想只做一个 demo`
- `所以我把它接成了一整条链路`

## Asset Checklist

Prepare these before recording:

- `6-8` short audio cards for the opening hook
- one `Controllable Cloning` demo sample
- one `Ultimate Cloning` sample with accurate prompt text
- one `Voice Design` sample
- one multilingual sample
- one clean UI recording for:
  - creating an episode
  - `切稿`
  - opening `TTS 配置`
  - opening `素材处理`
  - running synthesis
  - showing WhisperX review / retry / take switch
  - exporting audio + subtitle assets

## Opening Audio Card Suggestions

Use short labels instead of real creator names.
The hook should feel like "so many voices came from one system" without turning the video into direct impersonation theater.

Suggested card labels:

- `科技解说`
- `纪录片旁白`
- `轻松男声`
- `情绪女声`
- `英文旁白`
- `粤语口播`
- `续写克隆`
- `零样本音色`

Suggested short lines:

- `今天我们来聊一个离谱的本地 TTS 项目。`
- `你以为这只是声音克隆，但它后面其实是一整套工作流。`
- `同一套系统，能做模仿，也能做新音色。`
- `给它一段声音，它就能继续往下说。`
- `不给参考音频，它也能直接捏一个新声音。`
- `真正麻烦的，从来不是点一下生成。`

## Full Script

### 0:00 - 0:20 Opening Hook

Screen:

- dark background
- audio cards fly in from different directions
- each card pauses near center and plays one short line
- cards stack, overlap, then collapse into the title
- do not explain the product yet

Voice-over:

> 我这段时间做了一个项目。  
> 它最表面的效果，确实有点吓人。  
> 你给它几段参考音频，它就能把完全不同的声音，一张一张往外吐。  
> 而且上面这些，不是我东拼西凑找来的素材。  
> 是同一套系统跑出来的结果。

On-screen text:

- `同一套系统生成`
- `声音克隆 / 音色设计 / 续写复现`

Edit notes:

- cut fast
- keep each card under `1.5s`
- let the last card line finish half a beat before the title lands

### 0:20 - 0:40 Reverse The Expectation

Screen:

- title lands full screen
- cut from flashy montage to clean product UI
- show the project name and the main interface

Voice-over:

> 但我真正想做的，不是一个会整活的声音克隆 demo。  
> 这不是我最近发现的一个工具。  
> 这是我这段时间自己搭出来的一套东西。  
> 表面上它是在克隆声音。  
> 但我真正想解决的，是创作者做配音时那一整套又碎又烦的流程。

On-screen text:

- `tts-agent-harness`
- `不是整活 demo`
- `是本地配音工作台`

### 0:40 - 1:00 Controllable Cloning

Screen:

- open `TTS 配置`
- highlight `Controllable Cloning`
- show reference audio path and control prompt
- play A/B:
  - reference clip
  - cloned result
  - cloned result with style control

Voice-over:

> 所以底层我接的是 VoxCPM2。  
> 它最直接的一层能力，当然是可控克隆。  
> 你给一段参考音频，它先把音色抓住。  
> 再配一个 Control Prompt，你还能继续调语气、速度和风格。  
> 对创作者来说，这才像工具。  
> 因为真正做内容，不是只要像。  
> 是既要像，还要能控。

On-screen text:

- `Controllable Cloning`
- `保留音色`
- `可调语气 / 速度 / 风格`

### 1:00 - 1:20 Ultimate Cloning And Voice Design

Screen:

- switch to `Ultimate Cloning`
- show prompt audio + prompt text
- then quick montage:
  - `Voice Design`
  - multilingual samples
  - `48kHz` output badge

Voice-over:

> 如果你要的是更高保真，我还接了极致克隆。  
> 给它前文音频和对应文本，它不是单纯模仿一句。  
> 而是沿着原来的状态继续往下说。  
> 除此之外，它还能直接做音色设计。  
> 不给参考音频，也能从描述里捏一个新声音。  
> 再加上多语言和 48kHz 输出，它就不只是个模仿器了。

On-screen text:

- `Ultimate Cloning`
- `Prompt Audio + Prompt Text`
- `Voice Design`
- `Multilingual`
- `48kHz`

### 1:20 - 1:50 Script To Chunks

Screen:

- create or open an episode
- import `script.json` or paste text
- click `切稿`
- show chunk list filling the screen

Voice-over:

> 但真正让我花时间的，是把这些能力接成一套工作台。  
> 前面你可以直接导入 script.json，或者把文案贴进来。  
> 系统会先切 chunk。  
> 因为长旁白最怕的，不是不能生成。  
> 而是出了问题以后，根本没法改。  
> 切成 chunk 之后，后面每一句都能单独处理。

On-screen text:

- `导入脚本`
- `切稿`
- `每一句可单独处理`

### 1:50 - 2:20 Media Processing

Screen:

- open `素材处理`
- show import of `mp4` or `m4a`
- scrub a short segment
- choose cleanup mode
- apply to `可控克隆` or `极致克隆`

Voice-over:

> 然后在 TTS 配置里选模式。  
> 你可以直接做 Voice Design，也可以走可控克隆，或者极致克隆。  
> 要是参考素材本身是 mp4、mp3 这种文件，旁边还有个素材处理入口。  
> 可以先裁片段、做轻量清洗，或者做人声分离。  
> 处理完以后，再一键套进当前 Episode。  
> 这里我专门把这些步骤做进界面里。  
> 就是不想再手动倒腾一堆临时文件。

On-screen text:

- `素材处理`
- `mp4 / mov / mkv / mp3 / wav / m4a`
- `裁片段`
- `清洗 / 人声分离`
- `一键套用`

### 2:20 - 2:50 WhisperX Review And Rework

Screen:

- run synthesis
- show stage progress
- show WhisperX-based review result
- click a chunk
- retry one chunk
- show take switching

Voice-over:

> 后面跑合成的时候，它不是黑盒一把梭。  
> 我把 WhisperX 也接进来了，用来做复核。  
> 哪一条 chunk 念错了，气口不对，或者字幕对不上，直接在对应位置重试就行。  
> 你可以只改这一句的文案，只重跑这一句的阶段。  
> 甚至在多个 take 里切最终版本。  
> 这样返工成本才会真的下来。

On-screen text:

- `WhisperX 复核`
- `单 chunk 重试`
- `切 take`
- `返工成本下降`

### 2:50 - 3:20 Export And Builder Conclusion

Screen:

- export dialog
- reveal output folder
- show:
  - `episode.wav`
  - `episode.srt`
  - `subtitles.json`
  - `remotion-manifest.json`
  - shot-level WAV files

Voice-over:

> 最后导出也不是只给你一条 wav。  
> 我把整集音频、分 shot 音频、srt、subtitles.json 和 remotion-manifest 都一起打出来。  
> 因为我不想做一个只会生成一句话的页面。  
> 我想做的是一条能被视频创作流程真正接住的链路。  
> 你拿它不是为了炫一句像不像。  
> 而是能把一整期旁白真的做完。

On-screen text:

- `audio + subtitle + remotion assets`
- `不是一句话 demo`
- `是完整工作流`

### 3:20 - 3:40 Final Close

Screen:

- return to the interface overview
- mix in a few earlier best demo moments
- slow down pacing
- end on title or project name

Voice-over:

> 所以如果你问我，这个项目最有价值的地方是什么。  
> 不是它能像谁说话。  
> 而是我把它做成了一个本地可控、可返工、可导出的配音工作台。  
> 演示仅基于授权或自制素材。  
> 别拿去冒充别人。  
> 拿去做创作，才是它真正该干的事。

On-screen text:

- `本地可控`
- `可返工`
- `可导出`
- `仅基于授权或自制素材演示`

## Pacing Notes

- The first `30s` should prioritize `shock -> reversal`.
- The middle section should prioritize `workflow proof`, not parameter explanation.
- Every feature callout should answer one of two questions:
  - `为什么这东西看起来很猛？`
  - `为什么它不只是个玩具？`
- Avoid these phrases in the final recording:
  - `我试了一个工具`
  - `我发现一个项目`
  - `今天体验一下`

## Recording Notes

- Read the builder lines with a calm, certain tone, not a review tone.
- Do not rush the reverse section at `0:20 - 0:40`; this is where the audience learns the project is yours.
- Keep the ethics reminder only at the end so the hook stays intact.
- If the full script runs long, cut examples before cutting the workflow explanation.
