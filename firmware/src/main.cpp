#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <lvgl.h>
#include "display_config.h"
#include "config.h"
#include "ui.h"
#include "touch.h"

// Display (LovyanGFX for SPI LCD)
static LGFX tft;

// Touch (CHSC6540 with INT-pin driven detection)
static CHSC6540Touch touch;

// LVGL draw buffer
static lv_disp_draw_buf_t draw_buf;
static lv_color_t buf1[TFT_HOR_RES * 10];
static lv_color_t buf2[TFT_HOR_RES * 10];
static lv_disp_drv_t disp_drv;
static lv_indev_drv_t indev_drv;

// Device config
static DeviceConfig device_config;

// Route colors: line_number -> 0xRRGGBB
#include <map>
static std::map<String, uint32_t> route_colors;

// Fetch timing
static unsigned long last_fetch_ms = 0;
static const unsigned long FETCH_INTERVAL_MS = 30000;

// NTP time — POSIX TZ string handles CET/CEST transitions automatically
static const char* NTP_SERVER = "pool.ntp.org";
static const char* POSIX_TZ = "CET-1CEST,M3.5.0,M10.5.0/3";

// LVGL display flush callback
static void disp_flush_cb(lv_disp_drv_t* drv, const lv_area_t* area, lv_color_t* color_p) {
    uint32_t w = (area->x2 - area->x1 + 1);
    uint32_t h = (area->y2 - area->y1 + 1);
    tft.startWrite();
    tft.setAddrWindow(area->x1, area->y1, w, h);
    tft.writePixels((lgfx::rgb565_t*)&color_p->full, w * h);
    tft.endWrite();
    lv_disp_flush_ready(drv);
}

// LVGL touch read callback — INT-pin driven CHSC6540 with coord transform
static void touch_read_cb(lv_indev_drv_t* drv, lv_indev_data_t* data) {
    uint16_t raw_x, raw_y;
    if (touch.read(raw_x, raw_y)) {
        // Raw coords are portrait (240x320), transform for landscape rotation 7
        uint16_t scr_x = (TFT_HOR_RES - 1) - raw_y;
        uint16_t scr_y = raw_x;
        if (scr_x >= TFT_HOR_RES) scr_x = 0;
        if (scr_y >= TFT_VER_RES) scr_y = 0;
        data->point.x = scr_x;
        data->point.y = scr_y;
        data->state = LV_INDEV_STATE_PR;
    } else {
        data->state = LV_INDEV_STATE_REL;
    }
}

// Connect to WiFi
static bool wifi_connect() {
    Serial.printf("Connecting to WiFi: %s\n", device_config.wifi_ssid.c_str());
    ui_show_status("Connecting to WiFi...");
    lv_timer_handler();

    WiFi.mode(WIFI_STA);
    WiFi.begin(device_config.wifi_ssid.c_str(), device_config.wifi_password.c_str());

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 40) {
        delay(500);
        lv_timer_handler();
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("WiFi connected, IP: %s\n", WiFi.localIP().toString().c_str());
        return true;
    }

    Serial.println("WiFi connection failed");
    return false;
}

// Parse "#RRGGBB" hex color string to uint32_t
static uint32_t parse_hex_color(const char* s) {
    if (!s || s[0] != '#' || strlen(s) < 7) return 0;
    return strtoul(s + 1, nullptr, 16);
}

// Fetch route colors from API (called once at startup)
static void fetch_route_colors() {
    HTTPClient http;
    String url = device_config.api_url + "/api/routes";
    http.begin(url);
    int httpCode = http.GET();
    if (httpCode != 200) {
        Serial.printf("Route colors fetch failed: %d\n", httpCode);
        http.end();
        return;
    }

    String payload = http.getString();
    http.end();

    JsonDocument doc;
    if (deserializeJson(doc, payload)) return;

    JsonArray routes = doc["routes"].as<JsonArray>();
    for (JsonObject route : routes) {
        const char* ref = route["ref"];
        const char* color = route["color"];
        if (ref && color) {
            route_colors[String(ref)] = parse_hex_color(color);
        }
    }
    Serial.printf("Loaded %d route colors\n", route_colors.size());
}

// Fetch departures from API
static void fetch_departures() {
    if (WiFi.status() != WL_CONNECTED) {
        ui_show_status("WiFi disconnected\nReconnecting...");
        lv_timer_handler();
        if (!wifi_connect()) {
            ui_show_status("WiFi failed\nRetrying in 30s...");
            return;
        }
    }

    ui_update_header(nullptr, true, nullptr);

    HTTPClient http;
    String url = device_config.api_url + "/api/departures/by-stop";
    http.begin(url);
    http.addHeader("Content-Type", "application/json");

    JsonDocument req_doc;
    req_doc["stop_ifopt"] = device_config.stop_ifopt;
    String req_body;
    serializeJson(req_doc, req_body);

    int httpCode = http.POST(req_body);

    if (httpCode != 200) {
        Serial.printf("HTTP error: %d\n", httpCode);
        char msg[64];
        snprintf(msg, sizeof(msg), "API error: %d\nRetrying in 30s...", httpCode);
        ui_show_status(msg);
        http.end();
        return;
    }

    String payload = http.getString();
    http.end();

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (err) {
        Serial.printf("JSON parse error: %s\n", err.c_str());
        ui_show_status("Data error\nRetrying in 30s...");
        return;
    }

    JsonArray departures = doc["departures"].as<JsonArray>();
    int count = departures.size();
    if (count > MAX_DEPARTURES) count = MAX_DEPARTURES;

    DepartureEntry entries[MAX_DEPARTURES];
    int i = 0;
    for (JsonObject dep : departures) {
        if (i >= MAX_DEPARTURES) break;
        entries[i].line_number = dep["line_number"].as<String>();
        entries[i].destination = dep["destination"].as<String>();
        entries[i].planned_time = dep["planned_time"].as<String>();
        entries[i].estimated_time = dep["estimated_time"].as<String>();
        entries[i].delay_minutes = dep["delay_minutes"] | 0;
        entries[i].platform = dep["platform"].as<String>();
        auto it = route_colors.find(entries[i].line_number);
        entries[i].line_color = (it != route_colors.end()) ? it->second : 0;
        i++;
    }

    ui_update_departures(entries, i);
    Serial.printf("Updated %d departures\n", i);
}

// Update clock display from NTP time
static void update_clock() {
    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) {
        char buf[6];
        strftime(buf, sizeof(buf), "%H:%M", &timeinfo);
        ui_update_header(nullptr, WiFi.status() == WL_CONNECTED, buf);
    }
}

void setup() {
    Serial.begin(115200);
    delay(200);
    Serial.println("Omniviv Departure Board starting...");

    // 1. Set up interface mode pins (must be before display init)
    lcd_setup_im_pins();

    // 2. Initialize backlight (off initially)
    backlight_init();

    // 3. Initialize display
    tft.init();

    // 4. Send GC9307 vendor-specific init commands (power/gamma)
    lcd_send_vendor_init(tft);

    // 5. Landscape + mirror correction + 180° (rotation 3 + mirror flag 4 = 7)
    tft.setRotation(7);

    // 6. Turn on backlight
    backlight_set(true);

    // 7. Initialize touch (CHSC6540 via INT-pin driven I2C)
    if (!touch.begin(TOUCH_SDA, TOUCH_SCL, TOUCH_INT, TOUCH_RST)) {
        Serial.println("Touch init FAILED");
    }

    // 8. Initialize LVGL
    lv_init();
    lv_disp_draw_buf_init(&draw_buf, buf1, buf2, TFT_HOR_RES * 10);

    lv_disp_drv_init(&disp_drv);
    disp_drv.hor_res = TFT_HOR_RES;
    disp_drv.ver_res = TFT_VER_RES;
    disp_drv.flush_cb = disp_flush_cb;
    disp_drv.draw_buf = &draw_buf;
    lv_disp_drv_register(&disp_drv);

    lv_indev_drv_init(&indev_drv);
    indev_drv.type = LV_INDEV_TYPE_POINTER;
    indev_drv.read_cb = touch_read_cb;
    lv_indev_drv_register(&indev_drv);

    // 9. Build UI
    ui_init();
    ui_init_settings();

    // 10. Register settings save callback
    ui_set_settings_save_cb([](const char* ssid, const char* pass, const char* api_url, const char* stop) {
        DeviceConfig new_config;
        new_config.wifi_ssid = ssid;
        new_config.wifi_password = pass;
        new_config.api_url = api_url;
        new_config.stop_ifopt = stop;
        new_config.valid = true;

        if (writeConfig(new_config)) {
            Serial.println("Config saved, rebooting...");
            delay(200);
            ESP.restart();
        } else {
            Serial.println("Failed to save config");
            ui_show_status("Save failed!\nTry again...");
        }
    });

    // 11. Read config
    device_config = readConfig();
    ui_set_config_ref(&device_config);

    if (!device_config.valid) {
        ui_show_status("Not configured\n\nFlash config\nvia web flasher");
        ui_update_header("Not Configured", false, "--:--");
        return;
    }

    ui_update_header(device_config.stop_ifopt.c_str(), false, "--:--");
    ui_show_status("Loading...");
    lv_timer_handler();

    // 12. Connect WiFi
    if (!wifi_connect()) {
        ui_show_status("WiFi failed\nCheck credentials\nRetrying in 30s...");
        ui_update_header(nullptr, false, nullptr);
        return;
    }

    // 13. Configure NTP with automatic CET/CEST transition
    configTzTime(POSIX_TZ, NTP_SERVER);

    // 14. Fetch route colors for line badges
    fetch_route_colors();

    // 15. Initial fetch
    fetch_departures();
    last_fetch_ms = millis();
}

void loop() {
    lv_timer_handler();

    unsigned long now = millis();

    // Periodic departure refresh
    if (device_config.valid && (now - last_fetch_ms >= FETCH_INTERVAL_MS)) {
        fetch_departures();
        last_fetch_ms = now;
    }

    // Update clock every second
    static unsigned long last_clock_ms = 0;
    if (now - last_clock_ms >= 1000) {
        update_clock();
        last_clock_ms = now;
    }

    delay(5);
}
