#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>
#include <RadioLib.h>
#include <SparkFun_u-blox_GNSS_v3.h>
#include <SparkFun_RV1805.h>
#include <Adafruit_LIS3DH.h>
#include <Adafruit_AMG88xx.h>

// Pin Configuration for Seeed Studio XIAO SAMD21 with Wio SX1262
#define LORA_NSS    3   
#define LORA_BUSY   2   
#define LORA_RST    1   
#define LORA_DIO1   0   
#define BATTERY_PIN A10  
#define VOUT_ENABLE 4 
#define RTC_INT_PIN 5

const uint8_t AMG8833_ADDRESS = 0x68;

SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
LoRaWANNode node(&radio, &US915);
SFE_UBLOX_GNSS gps;
RV1805 rtc;
Adafruit_LIS3DH lis = Adafruit_LIS3DH();
Adafruit_AMG88xx thermalSensor;
bool thermalSensorAvailable = false;

const float LOW_BATTERY_LIMIT = 4.2; 
const float MOORING_THRESHOLD = 0.025; // Variance threshold (g^2)

// LoRaWAN OTAA Credentials (Replace with your actual keys from Helium/ChirpStack)
uint64_t joinEui = 0x0000000000000000;
uint64_t devEui  = 0x0000000000000000;
uint8_t appKey[] = { 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF };
uint8_t nwkKey[] = { 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF };

// Compact 15-Byte LoRaWAN Payload Setup
struct __attribute__((__packed__)) Payload {
    int32_t lat;       // 4 Bytes: Latitude scaled by 10^7
    int32_t lon;       // 4 Bytes: Longitude scaled by 10^7
    uint16_t batt_mv;  // 2 Bytes: Battery in millivolts
    uint16_t variance; // 2 Bytes: Accelerometer variance scaled by 100000
    int16_t max_temp_centi_c; // 2 Bytes: Maximum AMG8833 pixel temperature * 100
    uint8_t flags;     // Bit 0=LowBatt, Bit 1=GPSFix, Bit 2=TiedUp, Bit 3=ThermalValid
};

void rtc_wake_isr() {}

void enter_deep_sleep() {
    digitalWrite(VOUT_ENABLE, LOW); 
    lis.setDataRate(LIS3DH_DATARATE_POWERDOWN); // Put accelerometer to sleep
    radio.sleep();
    rtc.clearInterrupts();
    SCB->SCR |= SCB_SCR_SLEEPDEEP_Msk;
    __WFI();
}

bool read_max_temperature(int16_t &maxTempCentiC) {
    if (!thermalSensorAvailable) return false;

    float pixels[AMG88xx_PIXEL_ARRAY_SIZE];
    thermalSensor.readPixels(pixels);
    float maxTempC = pixels[0];
    for (int i = 1; i < AMG88xx_PIXEL_ARRAY_SIZE; i++) {
        if (pixels[i] > maxTempC) maxTempC = pixels[i];
    }
    maxTempCentiC = (int16_t)(maxTempC * 100.0f);
    return true;
}

float calculate_accelerometer_variance() {
    const int SAMPLES = 30;
    float magnitudes[SAMPLES];
    float sum = 0.0;
    
    // Sample at 10Hz for 3 seconds
    for(int i = 0; i < SAMPLES; i++) {
        lis.read();
        // Convert to g-force units
        sensors_event_t event;
        lis.getEvent(&event);
        
        float x = event.acceleration.x / 9.80665;
        float y = event.acceleration.y / 9.80665;
        float z = event.acceleration.z / 9.80665;
        
        magnitudes[i] = sqrt(x*x + y*y + z*z);
        sum += magnitudes[i];
        delay(100);
    }
    
    float mean = sum / SAMPLES;
    float variance_sum = 0.0;
    for(int i = 0; i < SAMPLES; i++) {
        variance_sum += pow(magnitudes[i] - mean, 2);
    }
    
    return variance_sum / SAMPLES;
}

void setup() {
    pinMode(VOUT_ENABLE, OUTPUT);
    digitalWrite(VOUT_ENABLE, HIGH);
    Wire.begin();
    Wire.setClock(400000);

    pinMode(RTC_INT_PIN, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(RTC_INT_PIN), rtc_wake_isr, FALLING);
    if (!rtc.begin()) { while(1); }
    rtc.disableTrickleCharge();
    rtc.setCountdownTimer(15, COUNTDOWN_MINUTES, true, true);
    rtc.enableInterrupt(INTERRUPT_TIE);
    
    if(!gps.begin()) { while(1); }
    gps.setI2COutput(COM_TYPE_UBX); 
    
    if (!lis.begin(0x18) && !lis.begin(0x19)) { while(1); }
    lis.setRange(LIS3DH_RANGE_2_G);

    // RV-1805 uses 0x69, so close the AMG8833 address jumper to select 0x68.
    thermalSensorAvailable = thermalSensor.begin(AMG8833_ADDRESS, &Wire);
    
    int state = radio.begin();
    if(state != RADIOLIB_ERR_NONE) { while(1); }

    node.beginOTAA(joinEui, devEui, nwkKey, appKey);
    state = node.activateOTAA();
    while (state != RADIOLIB_LORAWAN_NEW_SESSION && state != RADIOLIB_LORAWAN_SESSION_RESTORED) {
        delay(10000);
        state = node.activateOTAA();
    }
}

void loop() {
    digitalWrite(VOUT_ENABLE, HIGH);
    lis.setDataRate(LIS3DH_DATARATE_10_HZ); // Wake accelerometer
    delay(50); 
    
    Payload dataPacket;
    dataPacket.flags = 0x00;
    dataPacket.max_temp_centi_c = 0;
    
    // 1. Process Mooring Status
    float var = calculate_accelerometer_variance();
    dataPacket.variance = (uint16_t)(var * 100000.0);
    if (var < MOORING_THRESHOLD) {
        dataPacket.flags |= 0x04; // Set Bit 2: Tied Up at Dock
    }
    
    // 2. Fetch GPS Telemetry
    if(gps.getPVT()) {
        dataPacket.lat = gps.getLatitude();
        dataPacket.lon = gps.getLongitude();
        dataPacket.flags |= 0x02; // Set Bit 1: GPS Fix Found
    } else {
        dataPacket.lat = 0;
        dataPacket.lon = 0;
    }
    
    // 3. Capture the hottest thermal-array pixel
    int16_t maxTempCentiC;
    if (read_max_temperature(maxTempCentiC)) {
        dataPacket.max_temp_centi_c = maxTempCentiC;
        dataPacket.flags |= 0x08;
    }

    // 4. Monitor NiCad Power Core
    uint32_t raw = analogRead(BATTERY_PIN);
    dataPacket.batt_mv = ((raw * 3300) / 1023) * 2; 
    if((dataPacket.batt_mv / 1000.0) <= LOW_BATTERY_LIMIT) {
        dataPacket.flags |= 0x01; // Set Bit 0: Low Battery
    }
    
    // 5. LoRaWAN Uplink
    node.sendReceive((uint8_t*)&dataPacket, sizeof(Payload), 1);
    
    enter_deep_sleep();
}