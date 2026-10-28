// Arduino Uno firmware: reads the TCS34725 colour sensor and answers short text commands over USB.
#include <Wire.h>
#include <stdlib.h>

const byte SENSOR = 0x29;
const byte LED_PIN = 6;
byte cycles = 21, gainCode = 1;
bool ledOn = true;
char command[32];
byte commandLength = 0;

void writeReg(byte reg, byte value) {
  Wire.beginTransmission(SENSOR);
  Wire.write(0x80 | reg);
  Wire.write(value);
  Wire.endTransmission();
}

byte readReg(byte reg) {
  Wire.beginTransmission(SENSOR);
  Wire.write(0x80 | reg);
  Wire.endTransmission(false);
  Wire.requestFrom(SENSOR, (byte)1);
  return Wire.available() ? Wire.read() : 0;
}

void configure() {
  writeReg(0x00, 0x01); // Turn on the oscillator; allow it to warm up.
  delay(3);
  writeReg(0x01, 256 - cycles);
  writeReg(0x0F, gainCode);
  writeReg(0x00, 0x03); // PON + AEN: collect all four light channels.
  delay((unsigned long)cycles * 24 / 10 + 4);
}

void printReading(const char *label) {
  Wire.beginTransmission(SENSOR);
  Wire.write(0xA0 | 0x14); // Auto-increment: read C, R, G, B as eight bytes.
  Wire.endTransmission(false);
  Wire.requestFrom(SENSOR, (byte)8);
  uint16_t values[4];
  for (byte i = 0; i < 4; i++) {
    byte low = Wire.available() ? Wire.read() : 0;
    byte high = Wire.available() ? Wire.read() : 0;
    values[i] = low | ((uint16_t)high << 8);
  }
  Serial.print(label);
  for (byte i = 0; i < 4; i++) { Serial.print(','); Serial.print(values[i]); }
  Serial.println();
}

void handleCommand() {
  if (command[0] == 'L') {
    ledOn = command[1] != '0';
    digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
    Serial.println(ledOn ? F("LED,1") : F("LED,0"));
  } else if (command[0] == 'S') {
    // S,<integration steps>,<gain code>: settings come through simulated UART.
    char *step = strtok(command + 2, ",");
    char *gain = strtok(NULL, ",");
    if (step && gain) {
      cycles = constrain(atoi(step), 1, 255);
      gainCode = constrain(atoi(gain), 0, 3);
      configure();
      Serial.println(F("CONFIG,OK"));
    }
  } else if (command[0] == 'C') {
    // The operator has placed a dry white card in the closed optical box.
    digitalWrite(LED_PIN, LOW);
    delay((unsigned long)cycles * 24 / 10 * 2 + 8);
    printReading("DARK");
    digitalWrite(LED_PIN, HIGH);
    delay((unsigned long)cycles * 24 / 10 * 2 + 8);
    printReading("WHITE");
    digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
    Serial.println(F("CAL,DONE"));
  } else if (command[0] == 'R') {
    delay((unsigned long)cycles * 24 / 10 + 4);
    printReading("READ");
  }
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(100000);
  Serial.print(F("SENSOR,ID,"));
  Serial.println(readReg(0x12), HEX);
  configure();
  Serial.println(F("BOOT,READY"));
}

void loop() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n') {
      command[commandLength] = 0;
      handleCommand();
      commandLength = 0;
    } else if (commandLength < sizeof(command) - 1) {
      command[commandLength++] = ch;
    }
  }
  static unsigned long lastPrint = 0;
  if (millis() - lastPrint >= 250 && (readReg(0x13) & 1)) {
    lastPrint = millis();
    printReading("LIVE");
  }
}
