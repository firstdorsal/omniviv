#pragma once

#include <Arduino.h>
#include "driver/i2c.h"

// CHSC6540 touch driver for VIEWE UEDX24320024E-WB-A board.
//
// This board's CHSC6540 variant has a broken count byte (buf[2] is always 0),
// so the standard ESP32_Display_Panel library cannot detect touches.
// Arduino Wire also returns all zeros, likely due to I2C transaction timing.
//
// This driver uses the ESP-IDF legacy I2C API with atomic write-read
// transactions (repeated start) which correctly reads touch data.
// The INT pin (falling-edge ISR) detects touch activity, and a short
// timeout determines touch release — the standard approach for
// capacitive controllers without reliable release signaling.

class CHSC6540Touch {
public:
    static constexpr uint8_t I2C_ADDR = 0x2E;
    static constexpr uint8_t DATA_REG = 0x00;
    static constexpr uint8_t DATA_LEN = 7;
    static constexpr unsigned long RELEASE_TIMEOUT_MS = 80;

    bool begin(int sda_pin, int scl_pin, int int_pin, int rst_pin = -1) {
        _int_pin = int_pin;

        // Reset if pin available
        if (rst_pin >= 0) {
            pinMode(rst_pin, OUTPUT);
            digitalWrite(rst_pin, LOW);
            delay(50);
            digitalWrite(rst_pin, HIGH);
            delay(100);
        }

        // Initialize ESP-IDF I2C bus
        i2c_config_t conf = {};
        conf.mode = I2C_MODE_MASTER;
        conf.sda_io_num = sda_pin;
        conf.scl_io_num = scl_pin;
        conf.sda_pullup_en = GPIO_PULLUP_ENABLE;
        conf.scl_pullup_en = GPIO_PULLUP_ENABLE;
        conf.master.clk_speed = 400000;

        esp_err_t err = i2c_param_config(I2C_NUM_0, &conf);
        if (err != ESP_OK) {
            Serial.printf("CHSC6540: i2c_param_config failed: %d\n", err);
            return false;
        }

        err = i2c_driver_install(I2C_NUM_0, I2C_MODE_MASTER, 0, 0, 0);
        if (err != ESP_OK) {
            Serial.printf("CHSC6540: i2c_driver_install failed: %d\n", err);
            return false;
        }

        // Verify chip responds by reading data
        uint8_t test_buf[DATA_LEN];
        uint8_t reg = DATA_REG;
        err = i2c_master_write_read_device(
            I2C_NUM_0, I2C_ADDR,
            &reg, 1,
            test_buf, DATA_LEN,
            pdMS_TO_TICKS(100)
        );
        if (err != ESP_OK) {
            Serial.printf("CHSC6540: I2C read failed: %d\n", err);
            return false;
        }

        // Configure INT pin with falling-edge ISR
        if (_int_pin >= 0) {
            pinMode(_int_pin, INPUT_PULLUP);
            attachInterruptArg(digitalPinToInterrupt(_int_pin), isr, this, FALLING);
            _use_int = true;
        }

        Serial.println("CHSC6540: init OK");
        return true;
    }

    // Read touch state. Returns true if touch is active.
    // x, y are in raw panel coordinates (portrait 240x320).
    bool read(uint16_t& x, uint16_t& y) {
        unsigned long now = millis();

        if (_use_int) {
            if (_int_fired) {
                _int_fired = false;
                if (readRawCoords(x, y)) {
                    _last_x = x;
                    _last_y = y;
                    _last_touch_ms = now;
                    _pressed = true;
                    return true;
                }
            }

            if (_pressed) {
                if (now - _last_touch_ms < RELEASE_TIMEOUT_MS) {
                    // Keep polling — INT may fire again during sustained touch
                    if (readRawCoords(x, y)) {
                        if (x != _last_x || y != _last_y) {
                            _last_x = x;
                            _last_y = y;
                            _last_touch_ms = now;
                        }
                    }
                    x = _last_x;
                    y = _last_y;
                    return true;
                }
                _pressed = false;
            }
            return false;
        }

        // Polling mode fallback (no INT pin)
        if (readRawCoords(x, y)) {
            if (x != _last_x || y != _last_y) {
                _last_x = x;
                _last_y = y;
                _last_touch_ms = now;
                _pressed = true;
            }
            if (_pressed && (now - _last_touch_ms < RELEASE_TIMEOUT_MS)) {
                x = _last_x;
                y = _last_y;
                return true;
            }
        }
        if (_pressed && (now - _last_touch_ms >= RELEASE_TIMEOUT_MS)) {
            _pressed = false;
        }
        return false;
    }

private:
    int _int_pin = -1;
    bool _use_int = false;
    volatile bool _int_fired = false;
    bool _pressed = false;
    uint16_t _last_x = 0;
    uint16_t _last_y = 0;
    unsigned long _last_touch_ms = 0;

    static void IRAM_ATTR isr(void* arg) {
        auto* self = static_cast<CHSC6540Touch*>(arg);
        self->_int_fired = true;
    }

    bool readRawCoords(uint16_t& x, uint16_t& y) {
        uint8_t reg = DATA_REG;
        uint8_t buf[DATA_LEN];

        esp_err_t err = i2c_master_write_read_device(
            I2C_NUM_0, I2C_ADDR,
            &reg, 1,
            buf, DATA_LEN,
            pdMS_TO_TICKS(10)
        );
        if (err != ESP_OK) {
            return false;
        }

        x = ((buf[3] & 0x0F) << 8) | buf[4];
        y = ((buf[5] & 0x0F) << 8) | buf[6];

        return (x > 0 && x < 240 && y > 0 && y < 320);
    }
};
