---
name: voiceover
description: Adding AI-generated voiceover to Remotion compositions using TTS
metadata:
  tags: voiceover, audio, elevenlabs, tts, speech, calculateMetadata, dynamic duration
---

# Adding AI voiceover to a Remotion composition

Use ElevenLabs TTS to generate speech audio per scene, then use [`calculateMetadata`](./calculate-metadata) to dynamically size the composition to match the audio.

## Prerequisites

This guide covers multiple TTS providers. Pick based on what the user has and what language they need:

- **ElevenLabs** (`ELEVENLABS_API_KEY`) — highest quality, multilingual, but **paid** and requires an API key. Best when the user already has an account or explicitly wants top-tier voices.
- **edge-tts** (Microsoft Edge TTS, free, no API key) — **recommended default** for users without an ElevenLabs key, especially for **Chinese** (`zh-CN-XiaoxiaoNeural`, `zh-CN-YunxiNeural`, etc. are high quality). Install via `pip install edge-tts` (Python) and call the CLI. See "Generating audio with edge-tts" below.
- **macOS `say`** / **Windows SAPI** — zero-install fallback for local-only renders; quality is lower and voice list is machine-dependent.

If the user has not specified a TTS provider, **do not block on ElevenLabs** — try `edge-tts` first (it's free and covers most languages well). Only recommend ElevenLabs and ask for an API key when the user explicitly wants premium quality or edge-tts is unavailable.

Ensure any required environment variable is available when running the generation script:

```bash
node --strip-types generate-voiceover.ts
```

## Generating audio with edge-tts (free, no API key)

`edge-tts` is a Python CLI that wraps Microsoft's public TTS endpoint. It needs no API key and produces natural-sounding speech in many languages, with strong Chinese voice coverage. Install once:

```bash
pip install edge-tts
```

List available voices (filter by language as needed):

```bash
edge-tts --list-voices | grep zh-CN    # Chinese voices
edge-tts --list-voices | grep en-US    # English voices
```

Synthesize a single line to an MP3:

```bash
edge-tts --voice "zh-CN-XiaoxiaoNeural" --rate="-5%" \
  --text "欢迎来到 Molio，全新的知识管理工具。" \
  --write-media out/audio/scene-01.mp3
```

- `--rate` accepts signed percentages (`-5%` slows down, `+5%` speeds up). Slow down slightly for cinematic/narration tone.
- For a more "announcement" tone, try `zh-CN-YunxiNeural` (male, lower).
- The output is MP3 — convert to WAV with `ffmpeg -i in.mp3 -c:a pcm_s16le out.wav` if you need to concatenate with `anullsrc` silence gaps between scenes.
- To mix the voiceover with background music, lower the music track and combine them: `ffmpeg -i vo.wav -i bg.wav -filter_complex "[0]volume=1.0[a];[1]volume=0.25[b];[a][b]amix=inputs=2[out]" -map "[out]" mixed.wav`. Then merge into the video with `ffmpeg -i video.mp4 -i mixed.wav -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest out.mp4`.

Generate one MP3 per scene, then sequence them with silence gaps to match each scene's start frame (see "Dynamic composition duration with calculateMetadata" below for aligning audio with scene timing).


## Generating audio with ElevenLabs

Create a script that reads the config, calls the ElevenLabs API for each scene, and writes MP3 files to the `public/` directory so Remotion can access them via `staticFile()`.

The core API call for a single scene:

```ts title="generate-voiceover.ts"
const response = await fetch(
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
  {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY!,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: "Welcome to the show.",
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3,
      },
    }),
  },
);

const audioBuffer = Buffer.from(await response.arrayBuffer());
writeFileSync(`public/voiceover/${compositionId}/${scene.id}.mp3`, audioBuffer);
```

## Dynamic composition duration with calculateMetadata

Use [`calculateMetadata`](./calculate-metadata.md) to measure the [audio durations](./get-audio-duration.md) and set the composition length accordingly.

```tsx
import { CalculateMetadataFunction, staticFile } from "remotion";
import { getAudioDuration } from "./get-audio-duration";

const FPS = 30;

const SCENE_AUDIO_FILES = [
  "voiceover/my-comp/scene-01-intro.mp3",
  "voiceover/my-comp/scene-02-main.mp3",
  "voiceover/my-comp/scene-03-outro.mp3",
];

export const calculateMetadata: CalculateMetadataFunction<Props> = async ({
  props,
}) => {
  const durations = await Promise.all(
    SCENE_AUDIO_FILES.map((file) => getAudioDuration(staticFile(file))),
  );

  const sceneDurations = durations.map((durationInSeconds) => {
    return durationInSeconds * FPS;
  });

  return {
    durationInFrames: Math.ceil(sceneDurations.reduce((sum, d) => sum + d, 0)),
  };
};
```

The computed `sceneDurations` are passed into the component via a `voiceover` prop so the component knows how long each scene should be.

If the composition uses [`<TransitionSeries>`](./transitions.md), subtract the overlap from total duration: [./transitions.md#calculating-total-composition-duration](./transitions.md#calculating-total-composition-duration)

## Rendering audio in the component

See [audio.md](./audio.md) for more information on how to render audio in the component.

## Delaying audio start

See [audio.md#delaying](./audio.md#delaying) for more information on how to delay the audio start.
