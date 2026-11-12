<p align="center">
  <img src="assets/header.png" alt="bitwig-akai-lpd8-mk2: clip launcher and 64 assignable knobs for the Akai LPD8 mk2 in Bitwig Studio" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/blatantly_vibe--coded_with-Claude-D97757" alt="Blatantly vibe-coded with Claude">
  <img src="https://img.shields.io/badge/works_like_a-charm-2EA043" alt="Works like a charm">
</p>

A Bitwig Studio controller script for the **Akai LPD8 mk2**. It turns the pads into a colour-coded clip launcher, and the knobs into 8 banks of freely assignable controls. It needs no setup on the controller itself.

> **Only for the LPD8 mk2.** The first-generation LPD8 (no coloured pads) is not supported.

- [Install](#install) ([Linux](#linux), [Windows](#windows), [macOS](#macos))
- [Turn it on in Bitwig](#turn-it-on-in-bitwig)
- [How to use it](#how-to-use-it)
- [Troubleshooting](#troubleshooting)

---

## Install

The whole script is **one file**: `AkaiLPD8mk2.control.js`. Installing means putting that file into Bitwig's *Controller Scripts* folder. Pick your system below.

### Linux

**Option A: copy & paste one command**

Open a terminal, paste this, and press Enter:

```sh
mkdir -p ~/"Bitwig Studio/Controller Scripts" && curl -fL -o ~/"Bitwig Studio/Controller Scripts/AkaiLPD8mk2.control.js" https://github.com/relatively-okay/bitwig-akai-lpd8-mk2/releases/latest/download/AkaiLPD8mk2.control.js
```

**Option B: by hand**

1. Download the script: **[AkaiLPD8mk2.control.js](https://github.com/relatively-okay/bitwig-akai-lpd8-mk2/releases/latest/download/AkaiLPD8mk2.control.js)**
2. Open your home folder and go into **`Bitwig Studio`**, then **`Controller Scripts`**.
   If there is no `Controller Scripts` folder, create it (spelled exactly like that, with the space).
3. Move the downloaded `AkaiLPD8mk2.control.js` into `Controller Scripts`.

Now go to [Turn it on in Bitwig](#turn-it-on-in-bitwig).

### Windows

**Option A: copy & paste one command**

Press the **Windows key**, type **PowerShell**, open it, paste this, and press Enter:

```powershell
$d = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Bitwig Studio\Controller Scripts'; New-Item -ItemType Directory -Force -Path $d | Out-Null; Invoke-WebRequest -Uri 'https://github.com/relatively-okay/bitwig-akai-lpd8-mk2/releases/latest/download/AkaiLPD8mk2.control.js' -OutFile (Join-Path $d 'AkaiLPD8mk2.control.js')
```

**Option B: by hand**

1. Download the script: **[AkaiLPD8mk2.control.js](https://github.com/relatively-okay/bitwig-akai-lpd8-mk2/releases/latest/download/AkaiLPD8mk2.control.js)**
2. Open **File Explorer**, click **Documents**, then open **`Bitwig Studio`**, then **`Controller Scripts`**.
   If there is no `Controller Scripts` folder, create it (spelled exactly like that, with the space).
3. Move the downloaded `AkaiLPD8mk2.control.js` (it's in your **Downloads** folder) into `Controller Scripts`.

> Windows sometimes hides file extensions, so the file may show up as just `AkaiLPD8mk2.control`. That's fine. Don't rename it, and make sure it did **not** turn into `….js.txt`.

Now go to [Turn it on in Bitwig](#turn-it-on-in-bitwig).

### macOS

**Option A: copy & paste one command**

Open **Terminal** (press **Cmd + Space**, type *Terminal*, press Enter), paste this, and press Enter:

```sh
mkdir -p ~/Documents/"Bitwig Studio/Controller Scripts" && curl -fL -o ~/Documents/"Bitwig Studio/Controller Scripts/AkaiLPD8mk2.control.js" https://github.com/relatively-okay/bitwig-akai-lpd8-mk2/releases/latest/download/AkaiLPD8mk2.control.js
```

**Option B: by hand**

1. Download the script: **[AkaiLPD8mk2.control.js](https://github.com/relatively-okay/bitwig-akai-lpd8-mk2/releases/latest/download/AkaiLPD8mk2.control.js)**
2. Open **Finder**, click **Documents**, then open **`Bitwig Studio`**, then **`Controller Scripts`**.
   If there is no `Controller Scripts` folder, create it (spelled exactly like that, with the space).
3. Move the downloaded `AkaiLPD8mk2.control.js` (it's in your **Downloads** folder) into `Controller Scripts`.

Now go to [Turn it on in Bitwig](#turn-it-on-in-bitwig).

> **Can't find the `Bitwig Studio` folder?** It's the folder where Bitwig keeps your *Projects* and *Library*. `Controller Scripts` goes right next to those.

---

## Turn it on in Bitwig

1. Plug in the LPD8 mk2.
2. **Restart Bitwig Studio** (quit it completely and open it again).
3. Bitwig usually finds the controller by itself and shows **"LPD8 mk2 ready"**. Done!

If that popup doesn't appear, add the controller by hand:

1. Open Bitwig's **Settings** and go to **Controllers**.
2. Click **Add Controller**.
3. Choose **Akai** as the vendor and **LPD8 mk2** as the model, then click **Add**.
4. Set **both** dropdowns, the MIDI input *and* the MIDI output, to **LPD8 mk2**.
   The script needs the output too, so it can read the controller's settings and light up the pads.

You should now see **"LPD8 mk2 ready"**, and the pads light up.

---

## How to use it

Use the mode buttons on the LPD8 mk2 to choose what the pads do.

### CC mode: clip launcher

```
  ┌──────────────┬──────────────┬──────────────┬──────────────┐
  │  launch      │  launch      │  launch      │  scene       │
  │  track 1     │  track 2     │  scene       │  up          │
  ├──────────────┼──────────────┼──────────────┼──────────────┤
  │  stop        │  stop        │  stop        │  scene       │
  │  track 1     │  track 2     │  all         │  down        │
  └──────────────┴──────────────┴──────────────┴──────────────┘
```

It controls the first two tracks and one scene, and the scene buttons move that window up and down. The two launch pads show what's going on:

| Pad colour      | Meaning                         |
|-----------------|---------------------------------|
| off             | empty slot                      |
| amber           | there's a clip in the slot      |
| green           | playing                         |
| blinking green  | queued, starts on the next beat |
| blinking red    | stopping on the next beat       |

### PAD mode: play instruments

The pads play notes on the selected track, with pressure.

### Knobs: 64 assignable controls

The 8 knobs control 8 *banks* of 8 controls each. To pick a bank, switch to **PROG CHNG** mode and hit pad 1–8 (pad N = bank N). Bitwig shows which bank is active.

To assign a knob, right-click a parameter in Bitwig, choose **Map to Controller or Key**, and turn the knob.

> When you switch banks, a control jumps to wherever the physical knob is when you first move it.

### Your own LPD8 mk2 programs work too

The script doesn't assume the factory settings. Every time it starts, it reads the four programs from the controller and uses whatever knob and pad numbers you've set up, on any MIDI channel. It **never writes** anything to the controller.

If you change the programs with Akai's editor while Bitwig is running, switch the controller off and on in *Settings → Controllers* to make the script read them again.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **LPD8 mk2** isn't in the *Add Controller* list | The file isn't in the right place, or it isn't named right. It must be in `Bitwig Studio/Controller Scripts/` and end in **`.control.js`**. Then restart Bitwig. |
| Popup: *"no reply - check the controller's MIDI output port"* | In *Settings → Controllers*, set the controller's **output** to LPD8 mk2. |
| Popup: *"This is an original LPD8"* | This script only works with the LPD8 **mk2**. |
| Pads play notes but don't launch clips | Press the **CC** button on the LPD8 mk2. |
| Every second pad press is ignored | That pad is set to *toggle* in your program. Set it to *momentary*. |
| Something else | Open Bitwig's **Controller Script Console**. The script writes what it found and anything it ignored there, starting with `LPD8 mk2:`. |

---

## Compatibility

Developed and tested on Bitwig Studio 4.4 with a real LPD8 mk2. The script uses Bitwig's long-standing controller API (version 1), which Bitwig Studio 6.1 still ships and supports, so newer versions should work as well.

## Development

The script runs against a mock Bitwig host and a fake LPD8 mk2, using program dumps read from real hardware:

```sh
node test/run.js
```

This started as a fork of [stylemistake/bitwig-lpd8](https://github.com/stylemistake/bitwig-lpd8) (for the first-generation LPD8) and keeps its clip-launcher pad layout, but the code has since been rewritten for the mk2.

## License

[MIT](LICENSE)
