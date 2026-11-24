/**
 * The parts people can drag into a project. Prices are rough Indian retail prices in rupees for the common
 * hobby modules (Robu, Robocraze, local markets, late 2026) and only meant for budgeting.
 *
 * Electrical numbers are for the usual breakout boards, not the bare chips:
 *  - mA is a typical average while the project is running, peak is the worst short burst (Wi-Fi transmit,
 *    full-white LEDs at the brightness cap the generated code sets, a servo starting, a speaker at full volume).
 *  - supply says which rail the part takes power from. "either" parts run from 3.3 V on 3.3 V boards so
 *    their signal is safe for the pins, and from 5 V on 5 V boards.
 */

export type Category = "brain" | "power" | "sense" | "sound" | "light" | "move" | "show";
export type Signal =
  | "i2s_mic" | "i2s_amp" | "i2c" | "uart"
  | "in" | "out" | "pwm" | "analog" | "led_data" | "trig_echo";
export type Rail = "5v" | "3v3" | "either" | "none";

export interface Part {
  id: string;
  name: string;
  category: Category;
  /** what it is, for someone who has never seen one */
  plain: string;
  /** a short glyph for the canvas */
  icon: string;
  priceInr: number;
  /** width, height, depth in mm (the board or module, not counting wires) */
  size: [number, number, number];
  rail: Rail;
  /** allowed supply voltage range for the module */
  volts?: [number, number];
  mA: number;
  peakmA: number;
  signal?: Signal;
  /** pin names on the part, in the order the signal uses them */
  pins?: string[];
  /** I2C address, to catch two parts that would talk over each other */
  i2c?: number;
  /** the part only does its job with one of these also in the project */
  needsOneOf?: string[];
  /** an engineering note shown under "details" */
  note?: string;
  /** a safety note for children's products */
  kids?: string;
  /** Arduino libraries the generated code needs */
  libs?: string[];
}

export interface Board extends Part {
  category: "brain";
  logic: 3.3 | 5;
  /** lowest voltage on the 5 V / VIN pin that keeps it running */
  minIn: number;
  /** most current the board's own 3.3 V regulator can give to other parts */
  max3v3mA: number;
  canI2S: boolean;
  wifi: boolean;
  pinPools: {
    general: string[];
    analog: string[];
    led_data: string[];
    i2c?: [string, string];
    uart?: [string, string];
    i2s_mic?: [string, string, string];
    i2s_amp?: [string, string, string];
  };
  fqbn: string;
}

export interface Power extends Part {
  category: "power";
  /** nominal, lowest (nearly flat) and highest (fresh) voltage */
  v: [number, number, number];
  /** usable capacity in mAh, 0 for a mains adapter */
  mAh: number;
  maxmA: number;
  kind: "battery" | "usb" | "boost" | "switch";
}

export const BOARDS: Board[] = [
  {
    id: "esp32", name: "ESP32 board (Wi-Fi + Bluetooth)", category: "brain", icon: "◼",
    plain: "The brain. Runs your code, has Wi-Fi, and can listen through a digital microphone.",
    priceInr: 420, size: [55, 28, 13], rail: "5v", volts: [4.4, 6], mA: 70, peakmA: 160,
    logic: 3.3, minIn: 4.4, max3v3mA: 500, canI2S: true, wifi: true,
    note: "ESP32-WROOM DevKit V1, 30 pins. Current is with Wi-Fi off, as the generated code sets it; Wi-Fi adds bursts of up to 250 mA. Its 3.3 V regulator (AMS1117) needs about 4.4 V in. GPIO 6–11 are the flash chip and 34–39 are inputs only. Pins are 3.3 V: never feed them 5 V.",
    pinPools: {
      general: ["13", "4", "23", "18", "19", "5", "16", "17", "2", "15"],
      analog: ["34", "36", "39"],
      led_data: ["18", "19", "23"],
      i2c: ["21", "22"],
      uart: ["16", "17"],
      i2s_mic: ["32", "33", "35"],
      i2s_amp: ["26", "25", "27"],
    },
    fqbn: "esp32:esp32:esp32",
  },
  {
    id: "nano", name: "Arduino Nano", category: "brain", icon: "▪",
    plain: "A small, simple brain. No Wi-Fi and it can't listen to words, but it is easy and runs on 5 V parts.",
    priceInr: 330, size: [43, 18, 8], rail: "5v", volts: [4.6, 5.5], mA: 20, peakmA: 25,
    logic: 5, minIn: 4.6, max3v3mA: 25, canI2S: false, wifi: false,
    note: "ATmega328P clone with CH340 USB. 5 V logic. Its 3.3 V pin comes from the USB chip and gives only about 25 mA. Feed 5 V to the 5V pin, or 7–12 V to VIN.",
    pinPools: {
      general: ["D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D12", "D13", "A0", "A1", "A2", "A3"],
      analog: ["A0", "A1", "A2", "A3", "A6", "A7"],
      led_data: ["D6", "D5", "D3"],
      i2c: ["A4", "A5"],
      uart: ["D10", "D11"],
    },
    fqbn: "arduino:avr:nano",
  },
];

export const POWER: Power[] = [
  {
    id: "aa3", name: "3 × AA battery box with switch", category: "power", icon: "▥", kind: "battery",
    plain: "Three AA cells in a box. Safe and easy to replace. About 4.5 V.",
    priceInr: 60, size: [58, 48, 16], rail: "none", mA: 0, peakmA: 0, v: [4.5, 3.3, 4.8], mAh: 2000, maxmA: 1500,
    note: "Alkaline AA: 4.8 V fresh, 3.3 V nearly flat. Too low for a 5 V board on its own as it runs down; pair it with a 5 V booster.",
    kids: "Use a box whose lid is held by a screw, so a child can't get at the cells.",
  },
  {
    id: "aa4nimh", name: "4 × AA rechargeable (NiMH) box", category: "power", icon: "▥", kind: "battery",
    plain: "Four rechargeable AA cells. About 4.8 V, close to the 5 V most parts want.",
    priceInr: 520, size: [62, 58, 16], rail: "none", mA: 0, peakmA: 0, v: [4.8, 4.4, 5.6], mAh: 1900, maxmA: 2000,
    note: "NiMH: 5.6 V straight off the charger, about 4.8 V most of the time, 4.4 V nearly flat. Never put alkaline cells in a 4-cell box feeding 5 V parts: 4 fresh alkalines are 6.4 V.",
    kids: "Use a box whose lid is held by a screw. Charge the cells outside the toy.",
  },
  {
    id: "lipo", name: "Li-ion cell 3.7 V 1000 mAh + charger board", category: "power", icon: "▤", kind: "battery",
    plain: "A thin rechargeable battery with a USB charging board, like in a phone. Needs a 5 V booster.",
    priceInr: 380, size: [50, 34, 10], rail: "none", mA: 0, peakmA: 0, v: [3.7, 3.2, 4.2], mAh: 1000, maxmA: 1000,
    note: "Use a TP4056 board with the protection chip (DW01 + 8205, often sold as 'TP4056 with protection'). Charge at 1 A max for a 1000 mAh cell.",
    kids: "Lithium cells can catch fire if crushed or punctured. For young children prefer AA cells. If you use one, it must have a protection board and sit in a closed, screwed compartment away from sharp parts.",
  },
  {
    id: "usb", name: "USB power (charger or power bank)", category: "power", icon: "⎓", kind: "usb",
    plain: "Plug into any phone charger or power bank. A steady 5 V.",
    priceInr: 120, size: [30, 15, 8], rail: "none", mA: 0, peakmA: 0, v: [5, 4.75, 5.1], mAh: 0, maxmA: 2000,
    note: "Price is a USB cable and a panel socket. A power bank may switch itself off if the project draws under about 80 mA.",
  },
  {
    id: "boost5", name: "5 V booster (step-up board)", category: "power", icon: "⇡", kind: "boost",
    plain: "Turns 3–4.5 V from batteries into a steady 5 V, so nothing resets as the batteries run down.",
    priceInr: 60, size: [37, 17, 6], rail: "none", mA: 0, peakmA: 0, v: [5, 5, 5], mAh: 0, maxmA: 1000,
    note: "MT3608 (set the trimmer to 5.0 V with a meter before connecting anything) or a fixed 5 V boost board. About 85% efficient. It can't lower a voltage that is already above 5 V.",
  },
  {
    id: "switch", name: "On/off switch", category: "power", icon: "⏻", kind: "switch",
    plain: "A slide switch to turn it all off.",
    priceInr: 15, size: [12, 6, 6], rail: "none", mA: 0, peakmA: 0, v: [0, 0, 0], mAh: 0, maxmA: 500,
  },
];

export const PARTS: Part[] = [
  // sound
  {
    id: "mic", name: "Digital microphone (INMP441)", category: "sound", icon: "🎙",
    plain: "Hears voices and sounds clearly. Needs the ESP32.", priceInr: 180, size: [14, 14, 4],
    rail: "3v3", volts: [1.8, 3.6], mA: 2, peakmA: 2, signal: "i2s_mic", pins: ["SCK", "WS", "SD"],
    note: "I2S MEMS mic. Tie L/R to GND for the left channel. 3.3 V only.",
    kids: "The generated code only measures how loud it is, on the toy itself. Nothing is recorded, stored or sent anywhere, and Wi-Fi is switched off.",
  },
  {
    id: "soundsensor", name: "Sound sensor (clap detector)", category: "sound", icon: "👂",
    plain: "Notices loud sounds like a clap or a shout. Works with any brain.", priceInr: 60, size: [32, 15, 8],
    rail: "either", volts: [3.3, 5.5], mA: 4, peakmA: 4, signal: "analog", pins: ["AO"],
    note: "KY-038 / LM393 module. Use the analog output; the code sets the threshold.",
  },
  {
    id: "player", name: "MP3 voice player + microSD (DFPlayer Mini)", category: "sound", icon: "▶",
    plain: "Plays recorded voice lines or songs from a memory card. The easiest way to make it talk.", priceInr: 380, size: [21, 21, 12],
    rail: "5v", volts: [3.2, 5.2], mA: 20, peakmA: 400, signal: "uart", pins: ["RX", "TX"], needsOneOf: ["speaker"],
    note: "Price includes a 4–8 GB microSD card. Files go in the root as 0001.mp3, 0002.mp3… Its built-in 3 W amp drives the speaker directly. Put a 1 kΩ resistor in series with its RX pin.",
    libs: ["DFRobotDFPlayerMini"],
  },
  {
    id: "amp", name: "Speaker amplifier (MAX98357A)", category: "sound", icon: "◢",
    plain: "Lets the ESP32 speak in a robot voice with no memory card.", priceInr: 220, size: [18, 18, 4],
    rail: "5v", volts: [2.5, 5.5], mA: 60, peakmA: 600, signal: "i2s_amp", pins: ["BCLK", "LRC", "DIN"], needsOneOf: ["speaker"],
    note: "I2S class-D amp, 3.2 W into 4 Ω at 5 V. The robot voice uses ESP8266Audio + ESP8266SAM; build with Arduino-ESP32 core 2.0.17 so both I2S users share the same driver.",
    libs: ["ESP8266Audio", "ESP8266SAM"],
  },
  {
    id: "speaker", name: "Speaker 40 mm, 3 W 4 Ω", category: "sound", icon: "🔊",
    plain: "The speaker that makes the sound.", priceInr: 80, size: [40, 40, 20],
    rail: "none", mA: 0, peakmA: 0, needsOneOf: ["player", "amp"],
    note: "Mount it against holes in the case; the case makes it louder.",
    kids: "The code caps the volume. Keep it that way for small ears.",
  },
  {
    id: "buzzer", name: "Piezo buzzer", category: "sound", icon: "♪",
    plain: "Beeps and simple tunes.", priceInr: 20, size: [12, 12, 8],
    rail: "none", mA: 5, peakmA: 10, signal: "pwm", pins: ["+"],
  },
  // light
  {
    id: "ring", name: "Colour LED ring (12 LEDs)", category: "light", icon: "◎",
    plain: "Twelve lights that can be any colour and animate.", priceInr: 180, size: [37, 37, 3],
    rail: "5v", volts: [4.0, 5.3], mA: 120, peakmA: 290, signal: "led_data", pins: ["DIN"],
    note: "WS2812B. 60 mA per LED at full white; the code caps brightness at 40% so the peak is about 290 mA. Add a 330 Ω resistor in the data line and a 470 µF capacitor across 5 V and GND.",
    libs: ["Adafruit NeoPixel"],
    kids: "Brightness is capped in the code so it isn't dazzling and stays cool.",
  },
  {
    id: "strip", name: "Colour LED strip (30 LEDs, 1 m)", category: "light", icon: "━",
    plain: "A metre of colour lights.", priceInr: 350, size: [60, 12, 3],
    rail: "5v", volts: [4.0, 5.3], mA: 300, peakmA: 720, signal: "led_data", pins: ["DIN"],
    note: "WS2812B 30/m, rolled up for the size. Brightness capped at 40% in code (about 720 mA peak). Feed power at the strip, not through the board.",
    libs: ["Adafruit NeoPixel"],
  },
  {
    id: "led", name: "Single LED + resistor", category: "light", icon: "●",
    plain: "One small light, e.g. to show it's listening.", priceInr: 5, size: [5, 5, 9],
    rail: "none", mA: 8, peakmA: 10, signal: "out", pins: ["+"],
    note: "220 Ω resistor in series. Keeps the pin under 10 mA.",
  },
  // sense
  {
    id: "touch", name: "Touch pad (TTP223)", category: "sense", icon: "☝",
    plain: "Notices a finger touch, even through thin plastic.", priceInr: 25, size: [15, 11, 3],
    rail: "either", volts: [2.0, 5.5], mA: 1, peakmA: 1, signal: "in", pins: ["SIG"],
  },
  {
    id: "button", name: "Push button", category: "sense", icon: "⊙",
    plain: "A button to press.", priceInr: 10, size: [12, 12, 8],
    rail: "none", mA: 0, peakmA: 0, signal: "in", pins: ["1"],
    note: "Wired between the pin and GND; the code turns on the internal pull-up.",
  },
  {
    id: "pir", name: "Motion sensor (PIR)", category: "sense", icon: "⌁",
    plain: "Notices a person or pet moving nearby.", priceInr: 90, size: [32, 24, 25],
    rail: "5v", volts: [4.5, 12], mA: 1, peakmA: 1, signal: "in", pins: ["OUT"],
    note: "HC-SR501. Output is 3.3 V, safe for both boards. Takes about a minute to settle after power on.",
  },
  {
    id: "distance", name: "Distance sensor (ultrasonic)", category: "sense", icon: "⟫",
    plain: "Measures how far away something is, 2 cm to about 3 m.", priceInr: 70, size: [45, 20, 15],
    rail: "5v", volts: [4.5, 5.5], mA: 15, peakmA: 15, signal: "trig_echo", pins: ["TRIG", "ECHO"],
    note: "HC-SR04. Its ECHO pin outputs 5 V: on a 3.3 V board it goes through a 1 kΩ / 2 kΩ divider.",
  },
  {
    id: "light", name: "Light sensor (LDR)", category: "sense", icon: "☀",
    plain: "Tells if the room is bright or dark.", priceInr: 15, size: [5, 5, 5],
    rail: "either", volts: [2.0, 5.5], mA: 1, peakmA: 1, signal: "analog", pins: ["AO"],
    note: "LDR with a 10 kΩ resistor as a divider.",
  },
  {
    id: "temp", name: "Temperature + humidity (DHT22)", category: "sense", icon: "🌡",
    plain: "Measures how hot and how humid it is.", priceInr: 230, size: [25, 15, 8],
    rail: "either", volts: [3.3, 6], mA: 2, peakmA: 2, signal: "in", pins: ["DATA"],
    note: "AM2302 module with pull-up. Read at most every 2 seconds.",
    libs: ["DHT sensor library"],
  },
  {
    id: "soil", name: "Soil moisture sensor", category: "sense", icon: "≋",
    plain: "Tells when a plant's soil is dry.", priceInr: 90, size: [98, 23, 4],
    rail: "either", volts: [3.3, 5.5], mA: 5, peakmA: 5, signal: "analog", pins: ["AO"],
    note: "Capacitive v1.2 (doesn't corrode like the two-prong kind). Calibrate dry and wet readings in the code.",
  },
  {
    id: "motion6", name: "Shake / tilt sensor (MPU6050)", category: "sense", icon: "⟲",
    plain: "Notices shaking, tilting or a fall.", priceInr: 150, size: [21, 16, 3],
    rail: "either", volts: [3.3, 5], mA: 4, peakmA: 4, signal: "i2c", pins: ["SDA", "SCL"], i2c: 0x68,
  },
  {
    id: "reed", name: "Door/lid sensor (magnet switch)", category: "sense", icon: "⊐",
    plain: "Notices when a door, drawer or lid opens.", priceInr: 40, size: [27, 14, 8],
    rail: "none", mA: 0, peakmA: 0, signal: "in", pins: ["1"],
    note: "MC-38 reed switch, wired between the pin and GND with the internal pull-up.",
  },
  // move
  {
    id: "servo", name: "Small motor arm (SG90 servo)", category: "move", icon: "⟳",
    plain: "Turns an arm to a set angle: waving, opening a flap, nodding.", priceInr: 120, size: [23, 12, 29],
    rail: "5v", volts: [4.5, 6], mA: 100, peakmA: 650, signal: "pwm", pins: ["SIG"],
    note: "Stall current around 650 mA. Put a 470 µF capacitor near it so the brain doesn't reset when it starts.",
    libs: ["ESP32Servo"],
    kids: "Keep fingers away from the moving arm: cover the gears and limit the force in the code.",
  },
  {
    id: "vibe", name: "Vibration motor module", category: "move", icon: "≈",
    plain: "Buzzes and shakes, like a phone.", priceInr: 40, size: [25, 20, 8],
    rail: "5v", volts: [3, 5.3], mA: 60, peakmA: 120, signal: "out", pins: ["IN"],
    note: "A module with its own transistor and flyback diode. Never wire a bare motor to a pin.",
  },
  {
    id: "pump", name: "Mini water pump + switch board", category: "move", icon: "⛲",
    plain: "Pumps water through a thin tube, e.g. for a plant.", priceInr: 160, size: [45, 24, 24],
    rail: "5v", volts: [3, 5.5], mA: 40, peakmA: 400, signal: "out", pins: ["SIG"],
    note: "5 V submersible pump with a logic-level MOSFET module (or IRLZ44N + 1N4007 flyback diode). About 180 mA while running; the average assumes short bursts. Keep water away from the electronics.",
  },
  {
    id: "relay", name: "Relay (low-voltage DC loads only)", category: "move", icon: "⎍",
    plain: "Switches another battery-powered thing on and off, up to 24 V DC.", priceInr: 70, size: [50, 26, 19],
    rail: "5v", volts: [4.5, 5.5], mA: 70, peakmA: 75, signal: "out", pins: ["IN"],
    note: "1-channel 5 V relay module with transistor driver. This app only covers DC loads up to 24 V. Mains (wall socket) wiring is not supported.",
  },
  // show
  {
    id: "oled", name: "Small screen (0.96\" OLED)", category: "show", icon: "▭",
    plain: "A tiny screen for words and readings.", priceInr: 200, size: [27, 27, 4],
    rail: "either", volts: [3.3, 5], mA: 20, peakmA: 25, signal: "i2c", pins: ["SDA", "SCL"], i2c: 0x3c,
    note: "SSD1306 128×64, I2C address 0x3C.",
    libs: ["Adafruit SSD1306", "Adafruit GFX Library"],
  },
];

export const ALL: (Part | Board | Power)[] = [...BOARDS, ...POWER, ...PARTS];
export const BY_ID: Record<string, Part | Board | Power> = Object.fromEntries(ALL.map((p) => [p.id, p]));
export const isBoard = (p: Part): p is Board => p.category === "brain";
export const isPower = (p: Part): p is Power => p.category === "power";

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "brain", label: "Brains" },
  { id: "power", label: "Power" },
  { id: "sense", label: "Sensors" },
  { id: "sound", label: "Sound and voice" },
  { id: "light", label: "Lights" },
  { id: "move", label: "Movement" },
  { id: "show", label: "Screens" },
];

/** A project-box suggestion for a new build, in inside dimensions (mm). */
export const BOXES: { name: string; inner: [number, number, number]; priceInr: number }[] = [
  { name: "ABS project box 85 × 58 × 33 mm", inner: [80, 53, 30], priceInr: 90 },
  { name: "ABS project box 100 × 68 × 50 mm", inner: [95, 63, 46], priceInr: 120 },
  { name: "ABS project box 125 × 85 × 55 mm", inner: [120, 80, 51], priceInr: 170 },
  { name: "ABS project box 158 × 90 × 60 mm", inner: [152, 85, 56], priceInr: 230 },
  { name: "ABS project box 200 × 120 × 75 mm", inner: [194, 114, 70], priceInr: 380 },
];
