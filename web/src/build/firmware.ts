/**
 * Writes a starter Arduino sketch for a project: pin numbers from the checker, one small function per part,
 * and the "When… then…" list as a loop that reacts to the sensors. It is a starting point to upload and
 * then change, so it favours plain code over cleverness.
 */
import { analyze, type Report } from "./engine.ts";
import { BY_ID, type Part } from "./parts.ts";
import { ACTIONS, TRIGGERS, type Project, type Rule, type Trigger } from "./project.ts";

/** Text that is safe inside a C string. The robot voice only speaks plain English letters. */
export function cString(s: string, ascii = false): string {
  let x = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  if (ascii) x = x.normalize("NFKD").replace(/[^\x20-\x7e]/g, "");
  return x.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\?\?/g, "?\\?").slice(0, 120);
}

const hex = (c: string | undefined, fallback: [number, number, number]): [number, number, number] => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c ?? "");
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : fallback;
};

const ident = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");

export function firmware(project: Project, report: Report = analyze(project)): { name: string; code: string } {
  const board = report.board;
  const file = (project.name || "my_project").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "my_project";
  if (!board) return { name: `${file}.ino`, code: "// Add a brain (ESP32 or Arduino Nano) to get code.\n" };
  const esp = board.id === "esp32";
  const kids = project.product.forKids;
  const items = project.parts.map((p) => ({ placed: p, part: BY_ID[p.id] as Part })).filter((x) => x.part && report.pinsOf[x.placed.uid]);
  const first = (id: string) => items.find((x) => x.part.id === id);
  const pin = (id: string, name: string) => {
    const it = first(id);
    return it ? report.pinsOf[it.placed.uid][name] : undefined;
  };
  const has = (id: string) => !!first(id) || (id === "speaker" && project.parts.some((p) => p.id === "speaker"));
  const num = (p: string | undefined) => (p ?? "").replace(/^D/, ""); // Nano "D13" → 13, "A0" stays A0

  const rules = project.rules.filter((r) => {
    const t = TRIGGERS.find((x) => x.id === r.when)!;
    const a = ACTIONS.find((x) => x.id === r.then)!;
    return (!t.needs.length || t.needs.some(has)) && (!a.needs.length || a.needs.some(has));
  });
  const useVoice = has("player") ? "player" : has("amp") && esp ? "amp" : null;
  const lights = has("ring") ? "ring" : has("strip") ? "strip" : null;
  const ADC = esp ? 4095 : 1023;

  const L: string[] = [];
  const out = (...s: string[]) => L.push(...s);

  // ---- header ----------------------------------------------------------------------------------------------
  out(
    `// ${cString(project.name || "My project")}: starter code from RepairMind X Build.`,
    `// Board: ${esp ? "ESP32 Dev Module (Tools > Board > esp32 > ESP32 Dev Module)" : "Arduino Nano (Tools > Board > Arduino AVR Boards > Arduino Nano)"}`,
  );
  if (report.libs.length) out(`// Libraries (Tools > Manage Libraries): ${report.libs.join(", ")}`);
  if (useVoice === "amp") out("// Robot voice: use ESP32 board package 2.0.17 and ESP8266Audio 1.9.7, which share the classic I2S driver.");
  out("//", "// What it does:");
  if (!rules.length) out("//   Nothing yet. Add a \"When... then...\" in the builder.");
  for (const r of rules) out(`//   ${TRIGGERS.find((t) => t.id === r.when)!.label} -> ${ACTIONS.find((a) => a.id === r.then)!.label}${r.text ? `: "${cString(r.text)}"` : ""}`);
  out("//", "// Wiring (also in the builder's Wiring tab):");
  for (const p of report.pinMap) out(`//   ${esp ? "GPIO " : ""}${p.pin}: ${p.use}`);
  out("", "#include <Arduino.h>");
  if (esp) out("#include <WiFi.h>");
  if (has("mic") && esp) out("#include <driver/i2s.h>");
  if (lights) out("#include <Adafruit_NeoPixel.h>");
  if (useVoice === "player") {
    if (!esp) out("#include <SoftwareSerial.h>");
    out("#include <DFRobotDFPlayerMini.h>");
  }
  if (useVoice === "amp") out("#include <AudioOutputI2S.h>", "#include <ESP8266SAM.h>");
  if (has("servo")) out(esp ? "#include <ESP32Servo.h>" : "#include <Servo.h>");
  if (has("temp")) out("#include <DHT.h>");
  if (has("oled") || has("motion6")) out("#include <Wire.h>");
  if (has("oled")) out("#include <Adafruit_GFX.h>", "#include <Adafruit_SSD1306.h>");

  // ---- pins ------------------------------------------------------------------------------------------------
  out("", "// ---- pins ----");
  const def = (name: string, p: string | undefined) => { if (p) out(`const int ${name} = ${num(p)};`); };
  def("PIN_TOUCH", pin("touch", "SIG"));
  def("PIN_BUTTON", pin("button", "1"));
  def("PIN_MOTION", pin("pir", "OUT"));
  def("PIN_DOOR", pin("reed", "1"));
  def("PIN_LIGHT", pin("light", "AO"));
  def("PIN_SOIL", pin("soil", "AO"));
  def("PIN_SOUND", pin("soundsensor", "AO"));
  def("PIN_TRIG", pin("distance", "TRIG"));
  def("PIN_ECHO", pin("distance", "ECHO"));
  def("PIN_TEMP", pin("temp", "DATA"));
  def("PIN_LEDS", lights ? pin(lights, "DIN") : undefined);
  def("PIN_LED", pin("led", "+"));
  def("PIN_BUZZER", pin("buzzer", "+"));
  def("PIN_SERVO", pin("servo", "SIG"));
  def("PIN_VIBE", pin("vibe", "IN"));
  def("PIN_PUMP", pin("pump", "SIG"));
  def("PIN_RELAY", pin("relay", "IN"));
  if (has("mic") && esp) { def("PIN_MIC_SCK", pin("mic", "SCK")); def("PIN_MIC_WS", pin("mic", "WS")); def("PIN_MIC_SD", pin("mic", "SD")); }
  if (useVoice === "player") { def("PIN_PLAYER_RX", pin("player", "TX")); def("PIN_PLAYER_TX", pin("player", "RX")); }
  if (useVoice === "amp") { def("PIN_AMP_BCLK", pin("amp", "BCLK")); def("PIN_AMP_LRC", pin("amp", "LRC")); def("PIN_AMP_DIN", pin("amp", "DIN")); }
  if (has("oled") || has("motion6")) { def("PIN_SDA", esp ? pin(has("oled") ? "oled" : "motion6", "SDA") : undefined); def("PIN_SCL", esp ? pin(has("oled") ? "oled" : "motion6", "SCL") : undefined); }

  // ---- settings --------------------------------------------------------------------------------------------
  out("", "// ---- settings: change these to tune it ----");
  out("const unsigned long COOLDOWN_MS = 3000;   // wait this long before the same thing reacts again");
  if (rules.some((r) => r.when === "timer")) out("const unsigned long TIMER_MS = 5UL * 60UL * 1000UL;   // \"every few minutes\": 5 minutes");
  if (has("mic") && esp) out("int SOUND_LEVEL = 1500;   // loudness that counts as a voice; watch the Serial Monitor and adjust");
  else if (has("soundsensor")) out(`int SOUND_LEVEL = ${esp ? 400 : 100};   // swing that counts as a clap; watch the Serial Monitor and adjust`);
  if (has("light")) out(`int DARK_LEVEL = ${esp ? 800 : 200};   // below this the room counts as dark (0-${ADC})`);
  if (has("soil")) out(`int SOIL_DRY_RAW = ${esp ? 3000 : 600};   // reading with the sensor in air`, `int SOIL_WET_RAW = ${esp ? 1300 : 300};   // reading with the sensor in a glass of water`, "int DRY_PERCENT = 30;   // water below this");
  if (has("distance")) out("float NEAR_CM = 20;");
  if (has("motion6")) out("float SHAKE_G = 0.6;   // how hard a shake counts (in g away from still)");
  if (has("temp")) out("float HOT_C = 32;");
  if (lights) {
    const base = hex(rules.find((r) => r.then === "light")?.color, [255, 140, 40]);
    out(`const uint8_t MAX_BRIGHTNESS = 102;   // 40%: keeps current and heat down${kids ? ", and isn't dazzling" : ""}`);
    out(`const uint8_t GLOW_R = ${base[0]}, GLOW_G = ${base[1]}, GLOW_B = ${base[2]};   // the gentle glow it shows when idle`);
  }
  if (useVoice === "player") out(`const int VOLUME = ${kids ? 18 : 24};   // 0-30${kids ? ": capped for small ears" : ""}`);
  if (useVoice === "amp") out(`const float VOICE_GAIN = ${kids ? "0.3" : "0.5"};   // 0-1${kids ? ": capped for small ears" : ""}`);
  if (has("relay")) out("const int RELAY_ON = LOW;   // most relay boards switch on LOW; use HIGH if yours is the other way round");

  // ---- objects ---------------------------------------------------------------------------------------------
  out("");
  if (lights) out(`Adafruit_NeoPixel leds(${lights === "ring" ? 12 : 30}, PIN_LEDS, NEO_GRB + NEO_KHZ800);`);
  if (useVoice === "player") {
    out(esp ? "HardwareSerial &playerSerial = Serial2;" : "SoftwareSerial playerSerial(PIN_PLAYER_RX, PIN_PLAYER_TX);");
    out("DFRobotDFPlayerMini player;", "bool playerOk = false;");
  }
  if (useVoice === "amp") out("AudioOutputI2S *voiceOut = nullptr;");
  if (has("servo")) out("Servo arm;");
  if (has("temp")) out("DHT dht(PIN_TEMP, DHT22);");
  if (has("oled")) out("Adafruit_SSD1306 oled(128, 64, &Wire, -1);", "bool oledOk = false;", "char screenText[22] = \"\";", "unsigned long screenUntil = 0;");
  if (has("mic") && esp) out("const i2s_port_t MIC_PORT = I2S_NUM_1;");

  // readings
  const reads: string[] = [];
  if (has("mic") && esp || has("soundsensor")) reads.push("int soundLevel = 0;");
  if (has("light")) reads.push("int lightLevel = 0;");
  if (has("soil")) reads.push("int soilPct = 100;");
  if (has("distance")) reads.push("float distanceCm = -1;");
  if (has("motion6")) reads.push("float shakeG = 0;");
  if (has("temp")) reads.push("float tempC = NAN, humidity = NAN;", "unsigned long lastDht = 0;");
  if (reads.length) out("", "// latest readings", ...reads);
  out("unsigned long quietUntil = 0;   // ignore sounds while it is making its own");

  // ---- helpers ---------------------------------------------------------------------------------------------
  if (has("mic") && esp) {
    out(
      "",
      "// The microphone: only loudness is measured. Nothing is recorded or sent anywhere.",
      "void micBegin() {",
      "  i2s_config_t cfg = {};",
      "  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);",
      "  cfg.sample_rate = 16000;",
      "  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;",
      "  cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;   // L/R pin to GND. If it reads 0, try ONLY_RIGHT.",
      "  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;",
      "  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;",
      "  cfg.dma_buf_count = 4;",
      "  cfg.dma_buf_len = 256;",
      "  i2s_pin_config_t pins = {};",
      "  pins.mck_io_num = I2S_PIN_NO_CHANGE;",
      "  pins.bck_io_num = PIN_MIC_SCK;",
      "  pins.ws_io_num = PIN_MIC_WS;",
      "  pins.data_out_num = I2S_PIN_NO_CHANGE;",
      "  pins.data_in_num = PIN_MIC_SD;",
      "  i2s_driver_install(MIC_PORT, &cfg, 0, NULL);",
      "  i2s_set_pin(MIC_PORT, &pins);",
      "}",
      "",
      "int micLevel() {",
      "  static int32_t buf[256];",
      "  size_t got = 0;",
      "  if (i2s_read(MIC_PORT, buf, sizeof(buf), &got, 20 / portTICK_PERIOD_MS) != ESP_OK) return 0;",
      "  int n = got / 4;",
      "  if (n == 0) return 0;",
      "  double mean = 0, sum = 0;",
      "  for (int i = 0; i < n; i++) mean += buf[i] >> 14;",
      "  mean /= n;",
      "  for (int i = 0; i < n; i++) { double d = (buf[i] >> 14) - mean; sum += d * d; }",
      "  return (int)sqrt(sum / n);",
      "}",
    );
  } else if (has("soundsensor")) {
    out(
      "",
      "// The sound sensor: how far the signal swings in 20 ms.",
      "int micLevel() {",
      "  int lo = 4095, hi = 0;",
      "  unsigned long t = millis();",
      "  while (millis() - t < 20) { int v = analogRead(PIN_SOUND); if (v < lo) lo = v; if (v > hi) hi = v; }",
      "  return hi - lo;",
      "}",
    );
  }
  if (has("distance")) {
    out(
      "",
      "float readDistanceCm() {",
      "  digitalWrite(PIN_TRIG, LOW); delayMicroseconds(2);",
      "  digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(10);",
      "  digitalWrite(PIN_TRIG, LOW);",
      "  unsigned long us = pulseIn(PIN_ECHO, HIGH, 25000UL);",
      "  return us ? us / 58.0 : -1;",
      "}",
    );
  }
  if (has("motion6")) {
    out(
      "",
      "void mpuBegin() {",
      "  Wire.beginTransmission(0x68); Wire.write(0x6B); Wire.write(0); Wire.endTransmission();   // wake up",
      "}",
      "",
      "float readShake() {",
      "  Wire.beginTransmission(0x68); Wire.write(0x3B); Wire.endTransmission(false);",
      "  if (Wire.requestFrom(0x68, 6) != 6) return 0;",
      "  int16_t ax = (Wire.read() << 8) | Wire.read();",
      "  int16_t ay = (Wire.read() << 8) | Wire.read();",
      "  int16_t az = (Wire.read() << 8) | Wire.read();",
      "  float g = sqrt((float)ax * ax + (float)ay * ay + (float)az * az) / 16384.0;",
      "  return fabs(g - 1.0);   // 0 when still",
      "}",
    );
  }
  if (lights) {
    out(
      "",
      "void fill(uint8_t r, uint8_t g, uint8_t b) {",
      "  for (uint16_t i = 0; i < leds.numPixels(); i++) leds.setPixelColor(i, leds.Color(r, g, b));",
      "  leds.show();",
      "}",
      "",
      "// a slow breathing glow when nothing else is happening",
      "void glow() {",
      "  static unsigned long last = 0;",
      "  if (millis() - last < 30) return;",
      "  last = millis();",
      "  float k = 0.35 + 0.25 * sin(millis() / 900.0);",
      "  fill(GLOW_R * k, GLOW_G * k, GLOW_B * k);",
      "}",
      "",
      "void flash(uint8_t r, uint8_t g, uint8_t b) {",
      "  for (int s = 0; s < 2; s++) {",
      "    for (uint16_t i = 0; i < leds.numPixels(); i++) { leds.setPixelColor(i, leds.Color(r, g, b)); leds.show(); delay(25); }",
      "    delay(150);",
      "  }",
      "  for (int k = 100; k >= 35; k -= 5) { fill(r * k / 100, g * k / 100, b * k / 100); delay(20); }",
      "}",
    );
  }
  if (useVoice === "player") {
    out(
      "",
      "// Plays NNNN.mp3 from the memory card (files are numbered in the order they were copied).",
      "void say(int track) {",
      "  if (!playerOk) { Serial.println(F(\"(voice player not found: check wiring and the card)\")); return; }",
      "  player.play(track);",
      "  quietUntil = millis() + 4000;",
      "}",
    );
  }
  if (useVoice === "amp") {
    out(
      "",
      "// The robot voice. It reads English letters only.",
      "void say(const char *words) {",
      "  ESP8266SAM sam;",
      "  sam.Say(voiceOut, words);",
      "  quietUntil = millis() + 800;",
      "}",
    );
  }
  if (has("oled")) {
    out(
      "",
      "void showText(const char *text) {",
      "  strncpy(screenText, text, sizeof(screenText) - 1);",
      "  screenUntil = millis() + 4000;",
      "}",
      "",
      "void drawScreen() {",
      "  static unsigned long last = 0;",
      "  if (!oledOk || millis() - last < 500) return;",
      "  last = millis();",
      "  oled.clearDisplay();",
      "  oled.setTextColor(SSD1306_WHITE);",
      "  oled.setCursor(0, 0);",
      "  if (millis() < screenUntil) {",
      "    oled.setTextSize(2);",
      "    oled.println(screenText);",
      "  } else {",
      "    oled.setTextSize(1);",
      `    oled.println(F("${cString((project.name || "My project").slice(0, 21), true)}"));`,
    );
    if (has("temp")) out("    oled.print(F(\"Temp \")); oled.print(tempC, 1); oled.println(F(\" C\"));", "    oled.print(F(\"Humidity \")); oled.print(humidity, 0); oled.println(F(\" %\"));");
    if (has("soil")) out("    oled.print(F(\"Soil \")); oled.print(soilPct); oled.println(F(\" %\"));");
    if (has("distance")) out("    oled.print(F(\"Distance \")); oled.print(distanceCm, 0); oled.println(F(\" cm\"));");
    if (has("light")) out("    oled.print(F(\"Light \")); oled.println(lightLevel);");
    out("  }", "  oled.display();", "}");
  }

  // ---- actions ---------------------------------------------------------------------------------------------
  let track = 0;
  const act = (r: Rule): string[] => {
    switch (r.then) {
      case "say":
        if (useVoice === "player") return [`say(${++track});   // ${String(track).padStart(4, "0")}.mp3: "${cString(r.text || "Hello!")}"`];
        if (useVoice === "amp") return [`say("${cString(r.text || "Hello!", true) || "Hello"}");`];
        return [];
      case "light": {
        const [cr, cg, cb] = hex(r.color, [80, 200, 255]);
        if (lights) return [`flash(${cr}, ${cg}, ${cb});`];
        if (has("led")) return ["for (int i = 0; i < 3; i++) { digitalWrite(PIN_LED, HIGH); delay(150); digitalWrite(PIN_LED, LOW); delay(150); }"];
        return [];
      }
      case "beep": return ["tone(PIN_BUZZER, 1760, 120); delay(160); tone(PIN_BUZZER, 2093, 160); delay(200); noTone(PIN_BUZZER);", "quietUntil = millis() + 600;"];
      case "move": return ["for (int a = 0; a <= 90; a += 3) { arm.write(a); delay(12); }", "delay(300);", "for (int a = 90; a >= 0; a -= 3) { arm.write(a); delay(12); }"];
      case "pump": return ["digitalWrite(PIN_PUMP, HIGH); delay(3000); digitalWrite(PIN_PUMP, LOW);"];
      case "vibrate": return ["digitalWrite(PIN_VIBE, HIGH); delay(400); digitalWrite(PIN_VIBE, LOW);"];
      case "show": return [`showText("${cString((r.text || "Hello!").slice(0, 20), true) || "Hello!"}");`];
      case "switch": return ["digitalWrite(PIN_RELAY, RELAY_ON); delay(5000); digitalWrite(PIN_RELAY, !RELAY_ON);"];
    }
  };
  const actions = rules.map((r) => act(r));

  const cond: Record<Trigger, string> = {
    start: "false",
    timer: "millis() - lastTimer >= TIMER_MS",
    touch: "digitalRead(PIN_TOUCH) == HIGH",
    button: "digitalRead(PIN_BUTTON) == LOW",
    sound: "millis() > quietUntil && soundLevel > SOUND_LEVEL",
    motion: "digitalRead(PIN_MOTION) == HIGH",
    dark: "lightLevel < DARK_LEVEL",
    dry: "soilPct < DRY_PERCENT",
    near: "distanceCm > 0 && distanceCm < NEAR_CM",
    shake: "shakeG > SHAKE_G",
    open: "digitalRead(PIN_DOOR) == HIGH",
    hot: "!isnan(tempC) && tempC > HOT_C",
  };
  // these keep reacting while the condition lasts, but slowly; the rest react once each time it starts
  const LEVEL: Partial<Record<Trigger, string>> = { dry: "10UL * 60UL * 1000UL", hot: "10UL * 60UL * 1000UL" };

  const loopRules = rules.map((r, i) => ({ r, i })).filter((x) => x.r.when !== "start");
  for (const { r, i } of rules.map((r, i) => ({ r, i }))) {
    out("", `// ${TRIGGERS.find((t) => t.id === r.when)!.label} -> ${ACTIONS.find((a) => a.id === r.then)!.label}`, `void rule${i + 1}() {`, ...actions[i].map((s) => `  ${s}`), "}");
  }

  if (loopRules.length) {
    out("", `bool was[${rules.length}];`, `unsigned long lastRun[${rules.length}];`);
    if (rules.some((r) => r.when === "timer")) out("unsigned long lastTimer = 0;");
  }

  // ---- setup -----------------------------------------------------------------------------------------------
  out("", "void setup() {", "  Serial.begin(115200);");
  if (esp) out("  WiFi.mode(WIFI_OFF);   // not used: saves power, and nothing leaves the device");
  if (has("touch")) out("  pinMode(PIN_TOUCH, INPUT);");
  if (has("button")) out("  pinMode(PIN_BUTTON, INPUT_PULLUP);");
  if (has("pir")) out("  pinMode(PIN_MOTION, INPUT);");
  if (has("reed")) out("  pinMode(PIN_DOOR, INPUT_PULLUP);");
  if (has("distance")) out("  pinMode(PIN_TRIG, OUTPUT);", "  pinMode(PIN_ECHO, INPUT);");
  if (has("led")) out("  pinMode(PIN_LED, OUTPUT);");
  if (has("buzzer")) out("  pinMode(PIN_BUZZER, OUTPUT);");
  if (has("vibe")) out("  pinMode(PIN_VIBE, OUTPUT);", "  digitalWrite(PIN_VIBE, LOW);");
  if (has("pump")) out("  pinMode(PIN_PUMP, OUTPUT);", "  digitalWrite(PIN_PUMP, LOW);");
  if (has("relay")) out("  pinMode(PIN_RELAY, OUTPUT);", "  digitalWrite(PIN_RELAY, !RELAY_ON);");
  if (esp && (has("light") || has("soil") || has("soundsensor"))) out("  analogReadResolution(12);");
  if (lights) out("  leds.begin();", "  leds.setBrightness(MAX_BRIGHTNESS);", "  leds.clear();", "  leds.show();");
  if (has("servo")) out(esp ? "  arm.attach(PIN_SERVO, 500, 2400);" : "  arm.attach(PIN_SERVO);", "  arm.write(0);");
  if (has("temp")) out("  dht.begin();");
  if (has("oled") || has("motion6")) out(esp ? "  Wire.begin(PIN_SDA, PIN_SCL);" : "  Wire.begin();");
  if (has("motion6")) out("  mpuBegin();");
  if (has("oled")) out("  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);", "  if (!oledOk) Serial.println(F(\"Screen not found: check SDA/SCL\"));");
  if (has("mic") && esp) out("  micBegin();");
  if (useVoice === "player") {
    out(esp ? "  playerSerial.begin(9600, SERIAL_8N1, PIN_PLAYER_RX, PIN_PLAYER_TX);" : "  playerSerial.begin(9600);");
    out("  delay(800);   // the player needs a moment after power on", "  playerOk = player.begin(playerSerial);", "  if (playerOk) player.volume(VOLUME);", "  else Serial.println(F(\"Voice player not found: check RX/TX and the card\"));");
  }
  if (useVoice === "amp") out("  voiceOut = new AudioOutputI2S();", "  voiceOut->SetPinout(PIN_AMP_BCLK, PIN_AMP_LRC, PIN_AMP_DIN);", "  voiceOut->SetGain(VOICE_GAIN);", "  voiceOut->begin();");
  rules.forEach((r, i) => { if (r.when === "start") out(`  rule${i + 1}();`); });
  out("  Serial.println(F(\"Ready.\"));", "}");

  // ---- loop ------------------------------------------------------------------------------------------------
  out("", "void loop() {");
  if (has("mic") && esp || has("soundsensor")) out("  soundLevel = micLevel();");
  if (has("light")) out("  lightLevel = analogRead(PIN_LIGHT);");
  if (has("soil")) out("  soilPct = constrain(map(analogRead(PIN_SOIL), SOIL_DRY_RAW, SOIL_WET_RAW, 0, 100), 0, 100);");
  if (has("distance")) out("  distanceCm = readDistanceCm();");
  if (has("motion6")) out("  shakeG = readShake();");
  if (has("temp")) out("  if (millis() - lastDht > 2000) { lastDht = millis(); tempC = dht.readTemperature(); humidity = dht.readHumidity(); }");
  // read each trigger once, so two reactions to the same thing both happen
  const once = [...new Set(loopRules.map((x) => x.r.when))];
  for (const w of once) out(`  bool on_${w} = ${cond[w]};`);
  if (once.includes("timer")) out("  if (on_timer) lastTimer = millis();");
  for (const { r, i } of loopRules) {
    const c = `on_${r.when}`;
    if (r.when === "timer") {
      out(`  if (${c}) { rule${i + 1}(); }`);
    } else if (LEVEL[r.when]) {
      out(`  if (${c} && (lastRun[${i}] == 0 || millis() - lastRun[${i}] > ${LEVEL[r.when]})) { lastRun[${i}] = millis(); rule${i + 1}(); }`);
    } else {
      out(
        `  { bool now = ${c};`,
        `    if (now && !was[${i}] && millis() - lastRun[${i}] > COOLDOWN_MS) { lastRun[${i}] = millis(); rule${i + 1}(); }`,
        `    was[${i}] = now; }`,
      );
    }
  }
  if (lights) out("  glow();");
  if (has("oled")) out("  drawScreen();");
  // a reading every second helps set the thresholds
  const debug: string[] = [];
  if (has("mic") && esp || has("soundsensor")) debug.push("Serial.print(F(\"sound \")); Serial.print(soundLevel);");
  if (has("light")) debug.push("Serial.print(F(\" light \")); Serial.print(lightLevel);");
  if (has("soil")) debug.push("Serial.print(F(\" soil% \")); Serial.print(soilPct);");
  if (has("distance")) debug.push("Serial.print(F(\" cm \")); Serial.print(distanceCm);");
  if (has("motion6")) debug.push("Serial.print(F(\" shake \")); Serial.print(shakeG);");
  if (has("temp")) debug.push("Serial.print(F(\" C \")); Serial.print(tempC);");
  if (debug.length) out("  static unsigned long lastLog = 0;", "  if (millis() - lastLog > 1000) {", "    lastLog = millis();", ...debug.map((d) => `    ${d}`), "    Serial.println();", "  }");
  out("  delay(10);", "}", "");

  return { name: `${file}.ino`, code: L.join("\n") };
}

export { ident };
