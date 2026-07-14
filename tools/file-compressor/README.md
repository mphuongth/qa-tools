# file-compressor

Re-encodes a video so it lands near a target size — enough to get a screen recording under GitHub's
25 MiB browser-upload limit without hand-tuning ffmpeg flags.

Needs `ffmpeg` and `ffprobe` on the machine. Without them the hub disables video compression and the
CLI exits with a message; nothing else in the toolkit is affected.

## CLI

```bash
pnpm compress demo.mov                      # target 25 MiB (the GitHub upload limit)
pnpm compress demo.mov --target 8           # target 8 MiB
pnpm compress demo.mov --out /tmp/small.mp4 # choose the output path
```

The input is never modified. Output defaults to `<name>.compressed.mp4` next to the input.

## In the hub

The **File Compressor** page wraps the same module: it writes the upload to a temp directory, calls
`compressVideo()`, and streams the result back. It also gzips non-video files, which is UI-only.

## How the target size is hit

`buildVideoCompressionArgs` converts the target size into a bitrate: `targetBytes * 8 * 0.9 /
duration`, minus 96 kbit/s for audio. The 0.9 leaves headroom for container overhead and rate-control
overshoot, so the output lands slightly under target rather than slightly over — the direction that
matters when a hard limit is the whole point.

Floors of 360 kbit/s (total) and 250 kbit/s (video) stop a long video from being crushed into
something unwatchable, which means **a long enough video can exceed its target**. Video is also
scaled to at most 1280px wide and encoded as H.264/AAC.

## API

```js
import { compressVideo, detectCapabilities } from './tools/file-compressor/index.mjs';

const { videoTranscoding } = await detectCapabilities();
const { outputBytes, durationSeconds } = await compressVideo({
  inputPath: 'demo.mov',
  outputPath: 'demo.compressed.mp4',
  targetBytes: 8 * 1024 * 1024,
});
```
