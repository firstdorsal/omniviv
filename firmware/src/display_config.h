#pragma once

#define LGFX_USE_V1
#include <LovyanGFX.hpp>

// Resolution (landscape: 320 wide x 240 tall)
#define TFT_HOR_RES 320
#define TFT_VER_RES 240

// SPI LCD pins (GC9307, ST7789-compatible)
#define LCD_SCLK  40
#define LCD_MOSI  45
#define LCD_MISO  46  // SDO (optional readback)
#define LCD_CS    42
#define LCD_DC    41
#define LCD_RST   39

// Interface mode selection pins (GC9307)
// IM2IM1IM0 = 110 for 2.4" SPI mode (IM2 tied high on PCB)
#define LCD_IM0   47  // Set LOW
#define LCD_IM1   48  // Set HIGH

// Backlight
#define LCD_BL    13  // Active HIGH

// Touch pins (CHSC6540 capacitive, I2C)
#define TOUCH_SDA  1
#define TOUCH_SCL  3
#define TOUCH_INT  4
#define TOUCH_RST  2
#define TOUCH_I2C_ADDR 0x2E

// GC9307 vendor initialization commands
// Format: { cmd, data_ptr, data_len, delay_ms }
struct lcd_init_cmd_t {
    uint8_t cmd;
    const uint8_t* data;
    uint8_t len;
    uint16_t delay_ms;
};

static const uint8_t gc9307_data_86[]  = {0x98};
static const uint8_t gc9307_data_89[]  = {0x13};
static const uint8_t gc9307_data_8b[]  = {0x80};
static const uint8_t gc9307_data_8d[]  = {0x33};
static const uint8_t gc9307_data_8e[]  = {0x0f};
static const uint8_t gc9307_data_e8[]  = {0x12, 0x00};
static const uint8_t gc9307_data_ec[]  = {0x13, 0x02, 0x88};
static const uint8_t gc9307_data_ff[]  = {0x62};
static const uint8_t gc9307_data_99[]  = {0x3e};
static const uint8_t gc9307_data_9d[]  = {0x4b};
static const uint8_t gc9307_data_98[]  = {0x3e};
static const uint8_t gc9307_data_9c[]  = {0x4b};
static const uint8_t gc9307_data_c3[]  = {0x27};
static const uint8_t gc9307_data_c4[]  = {0x18};
static const uint8_t gc9307_data_c9[]  = {0x0a};
static const uint8_t gc9307_data_f0[]  = {0x47, 0x0c, 0x0A, 0x09, 0x15, 0x33};
static const uint8_t gc9307_data_f1[]  = {0x4b, 0x8F, 0x8f, 0x3B, 0x3F, 0x6f};
static const uint8_t gc9307_data_f2[]  = {0x47, 0x0c, 0x0A, 0x09, 0x15, 0x33};
static const uint8_t gc9307_data_f3[]  = {0x4b, 0x8f, 0x8f, 0x3B, 0x3F, 0x6f};

static const lcd_init_cmd_t gc9307_init_cmds[] = {
    {0xFE, nullptr,         0, 0},      // Internal register enable 1
    {0xEF, nullptr,         0, 0},      // Internal register enable 2
    {0x86, gc9307_data_86,  1, 0},
    {0x89, gc9307_data_89,  1, 0},
    {0x8B, gc9307_data_8b,  1, 0},
    {0x8D, gc9307_data_8d,  1, 0},
    {0x8E, gc9307_data_8e,  1, 0},
    {0xE8, gc9307_data_e8,  2, 0},
    {0xEC, gc9307_data_ec,  3, 0},
    {0xFF, gc9307_data_ff,  1, 0},
    {0x99, gc9307_data_99,  1, 0},
    {0x9D, gc9307_data_9d,  1, 0},
    {0x98, gc9307_data_98,  1, 0},
    {0x9C, gc9307_data_9c,  1, 0},
    {0xC3, gc9307_data_c3,  1, 0},      // Power control
    {0xC4, gc9307_data_c4,  1, 0},      // Power control
    {0xC9, gc9307_data_c9,  1, 0},
    {0xF0, gc9307_data_f0,  6, 0},      // Gamma positive
    {0xF1, gc9307_data_f1,  6, 0},      // Gamma negative
    {0xF2, gc9307_data_f2,  6, 0},      // Gamma positive 2
    {0xF3, gc9307_data_f3,  6, 0},      // Gamma negative 2
};
static const size_t gc9307_init_cmd_count = sizeof(gc9307_init_cmds) / sizeof(gc9307_init_cmds[0]);

// VIEWE UEDX24320024E-WB-A display configuration
// 2.4" 240x320 IPS TFT, GC9307 driver (ST7789-compatible), SPI bus
class LGFX : public lgfx::LGFX_Device {
public:
    lgfx::Bus_SPI _bus_instance;
    lgfx::Panel_ST7789 _panel_instance;

    LGFX(void) {
        // SPI bus configuration
        {
            auto cfg = _bus_instance.config();
            cfg.spi_host = SPI2_HOST;
            cfg.spi_mode = 0;
            cfg.freq_write = 80000000;  // 80 MHz SPI clock
            cfg.freq_read  = 16000000;
            cfg.pin_sclk = LCD_SCLK;
            cfg.pin_mosi = LCD_MOSI;
            cfg.pin_miso = LCD_MISO;
            cfg.pin_dc   = LCD_DC;
            _bus_instance.config(cfg);
        }

        // Panel configuration
        {
            auto cfg = _panel_instance.config();
            cfg.pin_cs   = LCD_CS;
            cfg.pin_rst  = LCD_RST;
            cfg.pin_busy = -1;

            // Physical panel memory is 240x320 (portrait)
            // MADCTL rotation makes logical view 320x240 (landscape)
            cfg.memory_width  = 240;
            cfg.memory_height = 320;
            cfg.panel_width   = 240;
            cfg.panel_height  = 320;
            cfg.offset_x = 0;
            cfg.offset_y = 0;

            cfg.invert   = false;
            cfg.rgb_order = false;  // BGR byte order

            _panel_instance.config(cfg);
        }

        _panel_instance.setBus(&_bus_instance);
        setPanel(&_panel_instance);
    }
};

// Set up interface mode selection pins (must be called before display init)
inline void lcd_setup_im_pins() {
    pinMode(LCD_IM0, OUTPUT);
    pinMode(LCD_IM1, OUTPUT);
    digitalWrite(LCD_IM0, LOW);   // IM0 = 0
    digitalWrite(LCD_IM1, HIGH);  // IM1 = 1
    // IM2 is tied HIGH on the PCB (IM2IM1IM0 = 110 for 2.4" SPI)
}

// Send GC9307 vendor-specific initialization commands (power/gamma only, no MADCTL)
inline void lcd_send_vendor_init(LGFX& tft) {
    tft.startWrite();
    for (size_t i = 0; i < gc9307_init_cmd_count; i++) {
        const auto& cmd = gc9307_init_cmds[i];
        tft.writeCommand(cmd.cmd);
        for (uint8_t j = 0; j < cmd.len; j++) {
            tft.writeData(cmd.data[j]);
        }
        if (cmd.delay_ms > 0) {
            delay(cmd.delay_ms);
        }
    }
    tft.endWrite();
}

// Initialize backlight
inline void backlight_init() {
    pinMode(LCD_BL, OUTPUT);
    digitalWrite(LCD_BL, LOW);  // Start with backlight off
}

inline void backlight_set(bool on) {
    digitalWrite(LCD_BL, on ? HIGH : LOW);
}
