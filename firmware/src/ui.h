#pragma once

#include <lvgl.h>
#include <Arduino.h>
#include "config.h"

// 320x240 landscape fits ~8 departure rows
#define MAX_DEPARTURES 6

struct DepartureEntry {
    String line_number;
    String destination;
    String planned_time;
    String estimated_time;
    int delay_minutes;
    String platform;
    uint32_t line_color; // 0xRRGGBB from route data, 0 = use fallback
};

// Callback type for saving settings
typedef void (*settings_save_cb_t)(const char* ssid, const char* pass, const char* api_url, const char* stop);

// Initialize the LVGL UI (departure screen)
void ui_init();

// Initialize the settings screen (call after ui_init)
void ui_init_settings();

// Update the departure list
void ui_update_departures(DepartureEntry* entries, int count);

// Show a status message (loading, error, not configured)
void ui_show_status(const char* message);

// Update the header info
void ui_update_header(const char* station_name, bool wifi_connected, const char* time_str);

// Show the settings screen, populated with current config values
void ui_show_settings(const DeviceConfig& config);

// Switch back to the departure screen
void ui_show_departures();

// Register a callback for when the user saves settings
void ui_set_settings_save_cb(settings_save_cb_t cb);

// Store a pointer to device config for the gear button
void ui_set_config_ref(const DeviceConfig* config);
