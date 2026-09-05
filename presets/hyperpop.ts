/**
 * hyperpop / rage-electronic.
 *
 * Cold, digital, hypnotic, loud. 150-160 BPM, straight timing, minor key, a
 * short repeated motif on a distorted supersaw over an enormous distorted 808,
 * trap-adjacent but rave-hard drums, and hard sidechain pumping under every
 * kick.
 *
 * Everything that decides how this sounds lives in this file and in
 * hyperpop.ranges.json. Nothing here reaches into DSP internals.
 */

import type { ArrangementTemplate } from "../compose/arrange.ts";
import { CONTOURS } from "../compose/motif.ts";
import type { Preset } from "./types.ts";

/**
 * Drum banks, ordered sparse to dense so intensity can bias the choice.
 * Written in the step notation: X accent, x hit, o medium, - ghost, . rest.
 */
const KICK = {
  patterns: [
    "X.......X.......",
    "X.......X...X...",
    "X.....X...X.....",
    "X...X...X...X...",
    "X.....X.X...X...",
    "X..X..X...X.X...",
    "X.X...X.X.X...X.",
    "X.XX..X.X.X..XX.",
  ],
};

const SNARE = {
  patterns: [
    "....X.......X...",
    "....X.......X..x",
    "....X...-...X...",
    "....X..-....X.-.",
    "....X.-.....X.x.",
  ],
};

const CLAP = {
  patterns: [
    "....X.......X...",
    "....X.......X...",
    "....x.......X..o",
    "............X...",
  ],
};

const HAT_CLOSED = {
  patterns: [
    "x.......x.......",
    "x.x.x.x.x.x.x.x.",
    "x-x-x-x-x-x-x-x-",
    "xxx.xxx.xxx.xxx.",
    "x.xxx.x.x.xxx.x.",
    "xxxxxxxxxxxxxxxx",
    "xXxxxXxxxXxxxXxx",
  ],
};

const HAT_OPEN = {
  patterns: [
    "................",
    "......o.........",
    "......o.......o.",
    "..o.......o.....",
    "......o...o...o.",
  ],
};

const RIM = {
  patterns: [
    "................",
    "................",
    "..-....-........",
    "..-....-...-....",
    "...-..-...-..-..",
  ],
};

/**
 * Four arrangements, each landing between 68 and 76 bars, which is a little
 * under two minutes across the tempo range. Variation starts here, because it
 * is the level a listener notices first.
 */
const ARRANGEMENTS: readonly ArrangementTemplate[] = [
  {
    name: "arc",
    sections: [
      { name: "intro",  bars: [8],      buses: ["pads", "fx"],                                  intensity: 0.12, filterOpen: 0.30, gainDb: -3, transitionIn: "none",    fillOut: false },
      { name: "build",  bars: [8],      buses: ["drums", "pads", "arp", "fx"],                  intensity: 0.50, filterOpen: 0.55, gainDb: -1, transitionIn: "riser",   fillOut: true  },
      { name: "drop",   bars: [16],     buses: ["drums", "bass808", "lead", "pads", "fx"],      intensity: 1.00, filterOpen: 1.00, gainDb:  0, transitionIn: "impact",  fillOut: false },
      { name: "break",  bars: [8],      buses: ["pads", "arp", "fx"],                           intensity: 0.28, filterOpen: 0.45, gainDb: -3, transitionIn: "reverse", fillOut: true  },
      { name: "drop2",  bars: [16],     buses: ["drums", "bass808", "lead", "arp", "pads", "fx"], intensity: 1.00, filterOpen: 1.00, gainDb: 0, transitionIn: "impact", fillOut: true  },
      { name: "bridge", bars: [8],      buses: ["drums", "bass808", "pads", "fx"],              intensity: 0.60, filterOpen: 0.70, gainDb: -2, transitionIn: "none",    fillOut: true  },
      { name: "outro",  bars: [8],      buses: ["pads", "fx"],                                  intensity: 0.18, filterOpen: 0.35, gainDb: -4, transitionIn: "reverse", fillOut: false },
    ],
  },
  {
    name: "straight-in",
    sections: [
      { name: "drop",   bars: [16],     buses: ["drums", "bass808", "lead", "pads", "fx"],      intensity: 1.00, filterOpen: 1.00, gainDb:  0, transitionIn: "impact",  fillOut: true  },
      { name: "break",  bars: [8],      buses: ["pads", "arp", "fx"],                           intensity: 0.30, filterOpen: 0.50, gainDb: -3, transitionIn: "reverse", fillOut: true  },
      { name: "drop2",  bars: [16],     buses: ["drums", "bass808", "lead", "arp", "pads", "fx"], intensity: 1.00, filterOpen: 1.00, gainDb: 0, transitionIn: "impact", fillOut: false },
      { name: "bridge", bars: [8],      buses: ["drums", "arp", "pads", "fx"],                  intensity: 0.55, filterOpen: 0.65, gainDb: -2, transitionIn: "none",    fillOut: true  },
      { name: "drop3",  bars: [16],     buses: ["drums", "bass808", "lead", "arp", "pads", "fx"], intensity: 1.00, filterOpen: 1.00, gainDb: 0, transitionIn: "impact", fillOut: true  },
      { name: "outro",  bars: [8],      buses: ["pads", "fx"],                                  intensity: 0.15, filterOpen: 0.30, gainDb: -4, transitionIn: "reverse", fillOut: false },
    ],
  },
  {
    name: "double-drop",
    sections: [
      { name: "intro",  bars: [4],      buses: ["pads", "fx"],                                  intensity: 0.12, filterOpen: 0.28, gainDb: -3, transitionIn: "none",    fillOut: false },
      { name: "drop",   bars: [16],     buses: ["drums", "bass808", "lead", "pads", "fx"],      intensity: 1.00, filterOpen: 1.00, gainDb:  0, transitionIn: "impact",  fillOut: true  },
      { name: "break",  bars: [4],      buses: ["pads", "fx"],                                  intensity: 0.22, filterOpen: 0.40, gainDb: -4, transitionIn: "reverse", fillOut: false },
      { name: "drop2",  bars: [16],     buses: ["drums", "bass808", "lead", "arp", "pads", "fx"], intensity: 1.00, filterOpen: 1.00, gainDb: 0, transitionIn: "impact", fillOut: true  },
      { name: "break2", bars: [4],      buses: ["arp", "pads", "fx"],                           intensity: 0.26, filterOpen: 0.45, gainDb: -4, transitionIn: "reverse", fillOut: true  },
      { name: "drop3",  bars: [16],     buses: ["drums", "bass808", "lead", "arp", "pads", "fx"], intensity: 1.00, filterOpen: 1.00, gainDb: 0, transitionIn: "impact", fillOut: true  },
      { name: "outro",  bars: [8],      buses: ["pads", "fx"],                                  intensity: 0.15, filterOpen: 0.32, gainDb: -4, transitionIn: "reverse", fillOut: false },
    ],
  },
  {
    name: "long-build",
    sections: [
      { name: "intro",  bars: [8],      buses: ["pads", "fx"],                                  intensity: 0.10, filterOpen: 0.25, gainDb: -4, transitionIn: "none",    fillOut: false },
      { name: "build",  bars: [16],     buses: ["drums", "arp", "pads", "fx"],                  intensity: 0.55, filterOpen: 0.60, gainDb: -1, transitionIn: "riser",   fillOut: true  },
      { name: "drop",   bars: [24],     buses: ["drums", "bass808", "lead", "arp", "pads", "fx"], intensity: 1.00, filterOpen: 1.00, gainDb: 0, transitionIn: "impact", fillOut: true  },
      { name: "break",  bars: [8],      buses: ["pads", "arp", "fx"],                           intensity: 0.30, filterOpen: 0.48, gainDb: -3, transitionIn: "reverse", fillOut: true  },
      { name: "drop2",  bars: [16],     buses: ["drums", "bass808", "lead", "pads", "fx"],      intensity: 1.00, filterOpen: 1.00, gainDb:  0, transitionIn: "impact",  fillOut: false },
      { name: "outro",  bars: [4],      buses: ["pads", "fx"],                                  intensity: 0.15, filterOpen: 0.30, gainDb: -5, transitionIn: "reverse", fillOut: false },
    ],
  },
];

export const hyperpop: Preset = {
  name: "hyperpop",
  title: "Hyperpop / rage",
  description:
    "Cold and digital. A distorted supersaw motif over an enormous 808, rave-hard drums, and everything pumping under the kick.",
  buses: ["drums", "bass808", "lead", "arp", "pads", "fx"],

  harmony: {
    // tonics low enough that the 808 sits where an 808 belongs
    tonics: [45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56],
    scales: [
      "naturalMinor",
      "phrygian",
      "harmonicMinor",
      "phrygianDominant",
      "minorPentatonic",
      "aeolianSharp4",
    ],
    degreeSets: [
      [0, 5, 3, 4],
      [0, 6, 5, 4],
      [0, 5, 0, 4],
      [0, 2, 5, 4],
      [0, 4, 5, 3],
      [0, 0, 5, 5],
      [0, 3, 4, 0],
      [0, 5, 6, 4],
    ],
    voicings: ["power", "powerOct", "sus2", "sus4", "minAdd9", "minor", "minor7"],
  },

  motif: {
    contours: CONTOURS,
    // scale-degree indices the melody may use, spanning about an octave and a half
    allowedDegrees: [0, 2, 3, 4, 6, 7, 9, 11],
    // positions within allowedDegrees that count as resolved: root, fifth, octave
    stableDegrees: [0, 3, 5],
  },

  drums: {
    kick: KICK,
    snare: SNARE,
    clap: CLAP,
    hatClosed: HAT_CLOSED,
    hatOpen: HAT_OPEN,
    rim: RIM,
    rolls: {
      chance: 0.3,
      divisions: [2, 3, 4, 6],
      candidates: [6, 7, 10, 11, 13, 14, 15],
      ramp: 1.4,
    },
  },

  arrangements: ARRANGEMENTS,

  words: [
    {
      name: "darker",
      label: "darker",
      hint: "closes the filters and takes the shine off the top",
      mappings: [
        { param: "lead.filterHz", mul: [1.9, 0.45] },
        { param: "arp.filterHz", mul: [1.7, 0.50] },
        { param: "pads.filterHz", mul: [1.6, 0.55] },
        { param: "bass.toneHz", mul: [1.4, 0.60] },
        { param: "drums.hat.highpassHz", mul: [1.2, 0.82] },
        { param: "drums.hat.gainDb", add: [2.0, -4.0] },
        { param: "master.shelfDb", add: [1.5, -2.2] },
        { param: "reverb.brightness", mul: [1.25, 0.70] },
      ],
    },
    {
      name: "harder",
      label: "harder",
      hint: "more drive everywhere and a deeper pump",
      mappings: [
        { param: "lead.distDrive", mul: [0.45, 2.2] },
        { param: "lead.ceiling", mul: [1.12, 0.82] },
        { param: "bass.drive", mul: [0.60, 1.8] },
        { param: "bass.distDrive", mul: [0.65, 1.7] },
        { param: "drums.kick.drive", mul: [0.75, 1.5] },
        { param: "drums.busDrive", mul: [0.82, 1.4] },
        { param: "master.satDrive", mul: [0.88, 1.22] },
        { param: "duck.depth", mul: [0.72, 1.28] },
      ],
    },
    {
      name: "wider",
      label: "wider",
      hint: "spreads the top of the mix, bass stays centred",
      mappings: [
        { param: "lead.spread", mul: [0.45, 1.15] },
        { param: "arp.spread", mul: [0.50, 1.15] },
        { param: "pads.spread", mul: [0.55, 1.10] },
        { param: "lead.chorusDepth", mul: [0.30, 1.8] },
        { param: "master.widthMid", mul: [0.20, 2.2] },
        { param: "lead.detuneCents", mul: [0.7, 1.25] },
      ],
    },
  ],

  maxBars: 96,
};
