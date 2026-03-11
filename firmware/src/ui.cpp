#include "ui.h"
#include "display_config.h"
#include <time.h>

// Compute UTC epoch from broken-down UTC time without touching TZ
static time_t utc_mktime(const struct tm& t) {
    static const int days_in_month[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    int year = t.tm_year + 1900;
    long days = 0;
    for (int y = 1970; y < year; y++) {
        days += (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)) ? 366 : 365;
    }
    for (int m = 0; m < t.tm_mon; m++) {
        days += days_in_month[m];
        if (m == 1 && (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)))
            days++;
    }
    days += t.tm_mday - 1;
    return days * 86400L + t.tm_hour * 3600 + t.tm_min * 60 + t.tm_sec;
}

// Parse ISO 8601 UTC time string to epoch seconds
static time_t utc_iso_to_epoch(const String& iso_time) {
    if (iso_time.length() < 19) return 0;

    struct tm utc_tm = {};
    utc_tm.tm_year = iso_time.substring(0, 4).toInt() - 1900;
    utc_tm.tm_mon  = iso_time.substring(5, 7).toInt() - 1;
    utc_tm.tm_mday = iso_time.substring(8, 10).toInt();
    utc_tm.tm_hour = iso_time.substring(11, 13).toInt();
    utc_tm.tm_min  = iso_time.substring(14, 16).toInt();
    utc_tm.tm_sec  = iso_time.substring(17, 19).toInt();

    return utc_mktime(utc_tm);
}

// Convert ISO 8601 UTC time string to local "HH:MM"
static String utc_to_local_hhmm(const String& iso_time) {
    time_t epoch = utc_iso_to_epoch(iso_time);
    if (epoch == 0) return iso_time.substring(11, 16);

    struct tm local_tm;
    localtime_r(&epoch, &local_tm);

    char buf[6];
    snprintf(buf, sizeof(buf), "%02d:%02d", local_tm.tm_hour, local_tm.tm_min);
    return String(buf);
}

// Get minutes until departure from an ISO 8601 UTC time string
static int minutes_until(const String& iso_time) {
    time_t dep_epoch = utc_iso_to_epoch(iso_time);
    if (dep_epoch == 0) return -1;
    time_t now = time(nullptr);
    int diff = (int)((dep_epoch - now) / 60);
    return diff < 0 ? 0 : diff;
}

// --- Main screen objects ---
static lv_obj_t* scr_main = nullptr;
static lv_obj_t* header = nullptr;
static lv_obj_t* lbl_station = nullptr;
static lv_obj_t* lbl_chevron = nullptr;
static lv_obj_t* lbl_wifi = nullptr;
static lv_obj_t* lbl_clock = nullptr;
static lv_obj_t* cont_departures = nullptr;
static lv_obj_t* lbl_status = nullptr;
static lv_obj_t* spinner_loading = nullptr;

// --- Settings panel objects (overlay on scr_main) ---
static lv_obj_t* cont_settings = nullptr;
static lv_obj_t* ta_ssid = nullptr;
static lv_obj_t* ta_password = nullptr;
static lv_obj_t* ta_api_url = nullptr;
static lv_obj_t* ta_stop = nullptr;
static lv_obj_t* kb_settings = nullptr;
static lv_obj_t* btn_show_pass = nullptr;
static bool pass_visible = false;
static bool settings_open = false;

// --- Callbacks and state ---
static settings_save_cb_t save_cb = nullptr;
static const DeviceConfig* config_ref = nullptr;

// Forward declarations
static void open_settings();
static void close_settings();

// Fallback color when route color is not available
static const uint32_t FALLBACK_LINE_COLOR = 0x3b82f6;

static lv_obj_t* create_departure_row(lv_obj_t* parent, const DepartureEntry& dep) {
    lv_obj_t* row = lv_obj_create(parent);
    lv_obj_set_size(row, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_style_pad_ver(row, 4, 0);
    lv_obj_set_style_pad_hor(row, 0, 0);
    lv_obj_set_style_border_width(row, 0, 0);
    lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(row, 4, 0);
    lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);

    // Line badge
    lv_obj_t* badge = lv_obj_create(row);
    lv_obj_set_size(badge, 40, 24);
    lv_color_t badge_color = lv_color_hex(dep.line_color ? dep.line_color : FALLBACK_LINE_COLOR);
    lv_obj_set_style_bg_color(badge, badge_color, 0);
    lv_obj_set_style_bg_opa(badge, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(badge, 4, 0);
    lv_obj_set_style_border_width(badge, 0, 0);
    lv_obj_set_style_pad_all(badge, 0, 0);
    lv_obj_clear_flag(badge, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t* badge_label = lv_label_create(badge);
    lv_label_set_text(badge_label, dep.line_number.c_str());
    lv_obj_set_style_text_color(badge_label, lv_color_white(), 0);
    lv_obj_set_style_text_font(badge_label, &lv_font_montserrat_14, 0);
    lv_obj_center(badge_label);

    // Destination — strip "Augsburg, " prefix
    lv_obj_t* lbl_dest = lv_label_create(row);
    const char* dest = dep.destination.c_str();
    if (strncmp(dest, "Augsburg, ", 10) == 0) dest += 10;
    lv_label_set_text(lbl_dest, dest);
    lv_obj_set_style_text_font(lbl_dest, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(lbl_dest, lv_color_white(), 0);
    lv_obj_set_flex_grow(lbl_dest, 1);
    lv_label_set_long_mode(lbl_dest, LV_LABEL_LONG_DOT);

    // Minutes until departure
    const String& dep_time_str = !dep.estimated_time.isEmpty() ? dep.estimated_time : dep.planned_time;
    int mins = minutes_until(dep_time_str);

    lv_obj_t* lbl_mins = lv_label_create(row);
    char mins_buf[12];
    if (mins == 0) {
        snprintf(mins_buf, sizeof(mins_buf), "now");
    } else {
        snprintf(mins_buf, sizeof(mins_buf), "%dm", mins);
    }
    lv_label_set_text(lbl_mins, mins_buf);
    lv_obj_set_style_text_font(lbl_mins, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(lbl_mins, mins <= 2 ? lv_color_hex(0xE53935) : lv_palette_main(LV_PALETTE_GREEN), 0);
    lv_obj_set_style_min_width(lbl_mins, 32, 0);
    lv_obj_set_style_text_align(lbl_mins, LV_TEXT_ALIGN_RIGHT, 0);

    // Absolute time — convert UTC to local timezone
    lv_obj_t* lbl_time = lv_label_create(row);
    String time_str = utc_to_local_hhmm(dep_time_str);
    lv_label_set_text(lbl_time, time_str.c_str());
    lv_obj_set_style_text_font(lbl_time, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(lbl_time, lv_color_hex(0x888888), 0);

    // Delay indicator
    if (dep.delay_minutes > 0) {
        lv_obj_t* lbl_delay = lv_label_create(row);
        char delay_buf[8];
        snprintf(delay_buf, sizeof(delay_buf), "+%d", dep.delay_minutes);
        lv_label_set_text(lbl_delay, delay_buf);
        lv_obj_set_style_text_color(lbl_delay, lv_color_hex(0xE53935), 0);
        lv_obj_set_style_text_font(lbl_delay, &lv_font_montserrat_12, 0);
    }

    return row;
}

// --- Settings panel open/close ---

static void open_settings() {
    if (settings_open) return;
    settings_open = true;

    Serial.println("Opening settings panel");

    // Populate fields with current config
    if (config_ref) {
        lv_textarea_set_text(ta_ssid, config_ref->wifi_ssid.c_str());
        lv_textarea_set_text(ta_password, config_ref->wifi_password.c_str());
        lv_textarea_set_text(ta_api_url, config_ref->api_url.c_str());
        lv_textarea_set_text(ta_stop, config_ref->stop_ifopt.c_str());
    }

    // Reset password visibility
    pass_visible = false;
    lv_textarea_set_password_mode(ta_password, true);
    lv_obj_t* eye_lbl = lv_obj_get_child(btn_show_pass, 0);
    if (eye_lbl) lv_label_set_text(eye_lbl, LV_SYMBOL_EYE_CLOSE);

    // Hide keyboard
    lv_obj_add_flag(kb_settings, LV_OBJ_FLAG_HIDDEN);

    // Swap panels
    lv_obj_add_flag(cont_departures, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(cont_settings, LV_OBJ_FLAG_HIDDEN);

    // Update chevron
    lv_label_set_text(lbl_chevron, LV_SYMBOL_UP);
}

static void close_settings() {
    if (!settings_open) return;
    settings_open = false;

    Serial.println("Closing settings panel");

    // Hide keyboard and settings
    lv_obj_add_flag(kb_settings, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(cont_settings, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(cont_departures, LV_OBJ_FLAG_HIDDEN);

    // Update chevron
    lv_label_set_text(lbl_chevron, LV_SYMBOL_DOWN);
}

// --- Event callbacks ---

static void header_click_cb(lv_event_t* e) {
    (void)e;
    if (settings_open) {
        close_settings();
    } else {
        open_settings();
    }
}

static void gesture_cb(lv_event_t* e) {
    lv_dir_t dir = lv_indev_get_gesture_dir(lv_indev_get_act());
    if (dir == LV_DIR_BOTTOM && !settings_open) {
        open_settings();
    } else if (dir == LV_DIR_TOP && settings_open) {
        close_settings();
    }
}

static void close_bar_cb(lv_event_t* e) {
    (void)e;
    close_settings();
}

static void save_btn_cb(lv_event_t* e) {
    (void)e;
    if (save_cb) {
        save_cb(
            lv_textarea_get_text(ta_ssid),
            lv_textarea_get_text(ta_password),
            lv_textarea_get_text(ta_api_url),
            lv_textarea_get_text(ta_stop)
        );
    }
}

static void show_pass_cb(lv_event_t* e) {
    (void)e;
    pass_visible = !pass_visible;
    lv_textarea_set_password_mode(ta_password, !pass_visible);
    lv_obj_t* lbl = lv_obj_get_child(btn_show_pass, 0);
    lv_label_set_text(lbl, pass_visible ? LV_SYMBOL_EYE_OPEN : LV_SYMBOL_EYE_CLOSE);
}

static void ta_focus_cb(lv_event_t* e) {
    lv_obj_t* ta = lv_event_get_target(e);
    lv_keyboard_set_textarea(kb_settings, ta);
    lv_obj_clear_flag(kb_settings, LV_OBJ_FLAG_HIDDEN);
}

static void kb_ready_cb(lv_event_t* e) {
    (void)e;
    lv_obj_add_flag(kb_settings, LV_OBJ_FLAG_HIDDEN);
}

// --- Helper: create a labeled textarea field ---

static lv_obj_t* create_settings_field(lv_obj_t* parent, const char* label_text, bool password) {
    lv_obj_t* lbl = lv_label_create(parent);
    lv_label_set_text(lbl, label_text);
    lv_obj_set_style_text_color(lbl, lv_color_hex(0xBBBBBB), 0);
    lv_obj_set_style_text_font(lbl, &lv_font_montserrat_12, 0);

    if (password) {
        // Row container for password field + eye toggle
        lv_obj_t* row = lv_obj_create(parent);
        lv_obj_set_size(row, LV_PCT(100), LV_SIZE_CONTENT);
        lv_obj_set_style_bg_opa(row, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(row, 0, 0);
        lv_obj_set_style_pad_all(row, 0, 0);
        lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
        lv_obj_set_style_pad_column(row, 4, 0);
        lv_obj_clear_flag(row, LV_OBJ_FLAG_SCROLLABLE);

        lv_obj_t* ta = lv_textarea_create(row);
        lv_textarea_set_one_line(ta, true);
        lv_textarea_set_password_mode(ta, true);
        lv_obj_set_flex_grow(ta, 1);
        lv_obj_set_height(ta, 30);
        lv_obj_set_style_text_font(ta, &lv_font_montserrat_12, 0);
        lv_obj_add_event_cb(ta, ta_focus_cb, LV_EVENT_FOCUSED, nullptr);

        btn_show_pass = lv_btn_create(row);
        lv_obj_set_size(btn_show_pass, 30, 30);
        lv_obj_set_style_bg_color(btn_show_pass, lv_color_hex(0x2A2A4A), 0);
        lv_obj_set_style_radius(btn_show_pass, 4, 0);
        lv_obj_set_style_pad_all(btn_show_pass, 0, 0);
        lv_obj_t* eye_lbl = lv_label_create(btn_show_pass);
        lv_label_set_text(eye_lbl, LV_SYMBOL_EYE_CLOSE);
        lv_obj_set_style_text_font(eye_lbl, &lv_font_montserrat_14, 0);
        lv_obj_center(eye_lbl);
        lv_obj_add_event_cb(btn_show_pass, show_pass_cb, LV_EVENT_CLICKED, nullptr);

        return ta;
    }

    lv_obj_t* ta = lv_textarea_create(parent);
    lv_textarea_set_one_line(ta, true);
    lv_obj_set_width(ta, LV_PCT(100));
    lv_obj_set_height(ta, 30);
    lv_obj_set_style_text_font(ta, &lv_font_montserrat_12, 0);
    lv_obj_add_event_cb(ta, ta_focus_cb, LV_EVENT_FOCUSED, nullptr);

    return ta;
}

// --- Public API ---

void ui_init() {
    scr_main = lv_scr_act();
    lv_obj_set_style_bg_color(scr_main, lv_color_hex(0x1A1A2E), 0);

    // Gesture detection on the screen
    lv_obj_add_event_cb(scr_main, gesture_cb, LV_EVENT_GESTURE, nullptr);

    // Header bar (24px)
    header = lv_obj_create(scr_main);
    lv_obj_set_size(header, TFT_HOR_RES, 24);
    lv_obj_align(header, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_set_style_bg_color(header, lv_color_hex(0x16213E), 0);
    lv_obj_set_style_border_width(header, 0, 0);
    lv_obj_set_style_radius(header, 0, 0);
    lv_obj_set_style_pad_hor(header, 4, 0);
    lv_obj_set_style_pad_ver(header, 2, 0);
    lv_obj_clear_flag(header, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_flex_flow(header, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(header, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    // Make the entire header tappable to toggle settings
    lv_obj_add_event_cb(header, header_click_cb, LV_EVENT_CLICKED, nullptr);

    // Station name
    lbl_station = lv_label_create(header);
    lv_label_set_text(lbl_station, "Departures");
    lv_obj_set_style_text_color(lbl_station, lv_color_white(), 0);
    lv_obj_set_style_text_font(lbl_station, &lv_font_montserrat_14, 0);
    lv_obj_set_flex_grow(lbl_station, 1);
    lv_label_set_long_mode(lbl_station, LV_LABEL_LONG_DOT);
    lv_obj_set_style_max_width(lbl_station, 220, 0);

    // Down chevron (settings toggle indicator)
    lbl_chevron = lv_label_create(header);
    lv_label_set_text(lbl_chevron, LV_SYMBOL_DOWN);
    lv_obj_set_style_text_color(lbl_chevron, lv_color_hex(0xBBBBBB), 0);
    lv_obj_set_style_text_font(lbl_chevron, &lv_font_montserrat_14, 0);

    // WiFi icon
    lbl_wifi = lv_label_create(header);
    lv_label_set_text(lbl_wifi, LV_SYMBOL_WIFI);
    lv_obj_set_style_text_color(lbl_wifi, lv_palette_main(LV_PALETTE_GREY), 0);
    lv_obj_set_style_text_font(lbl_wifi, &lv_font_montserrat_14, 0);

    // Clock
    lbl_clock = lv_label_create(header);
    lv_label_set_text(lbl_clock, "--:--");
    lv_obj_set_style_text_color(lbl_clock, lv_color_white(), 0);
    lv_obj_set_style_text_font(lbl_clock, &lv_font_montserrat_14, 0);

    // Departure list container
    cont_departures = lv_obj_create(scr_main);
    lv_obj_set_size(cont_departures, TFT_HOR_RES, TFT_VER_RES - 24);
    lv_obj_align(cont_departures, LV_ALIGN_TOP_LEFT, 0, 24);
    lv_obj_set_style_bg_color(cont_departures, lv_color_hex(0x1A1A2E), 0);
    lv_obj_set_style_border_width(cont_departures, 0, 0);
    lv_obj_set_style_radius(cont_departures, 0, 0);
    lv_obj_set_style_pad_ver(cont_departures, 2, 0);
    lv_obj_set_style_pad_hor(cont_departures, 0, 0);
    lv_obj_set_flex_flow(cont_departures, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(cont_departures, 1, 0);
    lv_obj_set_scrollbar_mode(cont_departures, LV_SCROLLBAR_MODE_AUTO);

    // Status label
    lbl_status = lv_label_create(cont_departures);
    lv_label_set_text(lbl_status, "");
    lv_obj_set_style_text_color(lbl_status, lv_palette_main(LV_PALETTE_GREY), 0);
    lv_obj_set_style_text_font(lbl_status, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_align(lbl_status, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl_status, LV_PCT(100));
    lv_obj_add_flag(lbl_status, LV_OBJ_FLAG_HIDDEN);

    // Loading spinner
    spinner_loading = lv_spinner_create(cont_departures, 1000, 60);
    lv_obj_set_size(spinner_loading, 32, 32);
    lv_obj_set_style_arc_color(spinner_loading, lv_palette_main(LV_PALETTE_BLUE), LV_PART_INDICATOR);
    lv_obj_add_flag(spinner_loading, LV_OBJ_FLAG_HIDDEN);
}

void ui_init_settings() {
    // Settings panel — same position/size as departures, starts hidden
    cont_settings = lv_obj_create(scr_main);
    lv_obj_set_size(cont_settings, TFT_HOR_RES, TFT_VER_RES - 24);
    lv_obj_align(cont_settings, LV_ALIGN_TOP_LEFT, 0, 24);
    lv_obj_set_style_bg_color(cont_settings, lv_color_hex(0x1A1A2E), 0);
    lv_obj_set_style_border_width(cont_settings, 0, 0);
    lv_obj_set_style_radius(cont_settings, 0, 0);
    lv_obj_set_style_pad_all(cont_settings, 6, 0);
    lv_obj_set_style_pad_row(cont_settings, 3, 0);
    lv_obj_set_flex_flow(cont_settings, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(cont_settings, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_add_flag(cont_settings, LV_OBJ_FLAG_HIDDEN);

    // Form fields
    ta_ssid = create_settings_field(cont_settings, "WiFi SSID", false);
    ta_password = create_settings_field(cont_settings, "WiFi Password", true);
    ta_api_url = create_settings_field(cont_settings, "API URL", false);
    ta_stop = create_settings_field(cont_settings, "Stop IFOPT", false);

    // Save & Reboot button
    lv_obj_t* btn_save = lv_btn_create(cont_settings);
    lv_obj_set_size(btn_save, LV_PCT(100), 32);
    lv_obj_set_style_bg_color(btn_save, lv_palette_main(LV_PALETTE_BLUE), 0);
    lv_obj_set_style_radius(btn_save, 6, 0);
    lv_obj_t* save_lbl = lv_label_create(btn_save);
    lv_label_set_text(save_lbl, "Save & Reboot");
    lv_obj_set_style_text_font(save_lbl, &lv_font_montserrat_14, 0);
    lv_obj_center(save_lbl);
    lv_obj_add_event_cb(btn_save, save_btn_cb, LV_EVENT_CLICKED, nullptr);

    // Close bar with up chevron at bottom
    lv_obj_t* close_bar = lv_obj_create(cont_settings);
    lv_obj_set_size(close_bar, LV_PCT(100), 28);
    lv_obj_set_style_bg_color(close_bar, lv_color_hex(0x16213E), 0);
    lv_obj_set_style_bg_opa(close_bar, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(close_bar, 6, 0);
    lv_obj_set_style_border_width(close_bar, 0, 0);
    lv_obj_set_style_pad_all(close_bar, 0, 0);
    lv_obj_clear_flag(close_bar, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(close_bar, close_bar_cb, LV_EVENT_CLICKED, nullptr);

    lv_obj_t* close_chevron = lv_label_create(close_bar);
    lv_label_set_text(close_chevron, LV_SYMBOL_UP);
    lv_obj_set_style_text_color(close_chevron, lv_color_hex(0xBBBBBB), 0);
    lv_obj_set_style_text_font(close_chevron, &lv_font_montserrat_14, 0);
    lv_obj_center(close_chevron);

    // On-screen keyboard (child of scr_main, not settings panel)
    kb_settings = lv_keyboard_create(scr_main);
    lv_obj_set_size(kb_settings, TFT_HOR_RES, 120);
    lv_obj_align(kb_settings, LV_ALIGN_BOTTOM_LEFT, 0, 0);
    lv_obj_add_flag(kb_settings, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_event_cb(kb_settings, kb_ready_cb, LV_EVENT_READY, nullptr);
    lv_obj_add_event_cb(kb_settings, kb_ready_cb, LV_EVENT_CANCEL, nullptr);
}

void ui_show_settings(const DeviceConfig& config) {
    open_settings();
}

void ui_show_departures() {
    close_settings();
}

void ui_set_settings_save_cb(settings_save_cb_t cb) {
    save_cb = cb;
}

void ui_set_config_ref(const DeviceConfig* config) {
    config_ref = config;
}

void ui_update_departures(DepartureEntry* entries, int count) {
    lv_obj_add_flag(lbl_status, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(spinner_loading, LV_OBJ_FLAG_HIDDEN);

    while (lv_obj_get_child_cnt(cont_departures) > 2) {
        lv_obj_del(lv_obj_get_child(cont_departures, 2));
    }

    if (count == 0) {
        lv_label_set_text(lbl_status, "No upcoming\ndepartures");
        lv_obj_clear_flag(lbl_status, LV_OBJ_FLAG_HIDDEN);
        return;
    }

    int shown = count > MAX_DEPARTURES ? MAX_DEPARTURES : count;
    for (int i = 0; i < shown; i++) {
        create_departure_row(cont_departures, entries[i]);
    }
}

void ui_show_status(const char* message) {
    while (lv_obj_get_child_cnt(cont_departures) > 2) {
        lv_obj_del(lv_obj_get_child(cont_departures, 2));
    }

    lv_label_set_text(lbl_status, message);
    lv_obj_clear_flag(lbl_status, LV_OBJ_FLAG_HIDDEN);

    if (strstr(message, "Loading") || strstr(message, "Connecting")) {
        lv_obj_clear_flag(spinner_loading, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(spinner_loading, LV_OBJ_FLAG_HIDDEN);
    }
}

void ui_update_header(const char* station_name, bool wifi_connected, const char* time_str) {
    if (station_name) {
        lv_label_set_text(lbl_station, station_name);
    }

    lv_obj_set_style_text_color(lbl_wifi,
        wifi_connected ? lv_palette_main(LV_PALETTE_GREEN) : lv_palette_main(LV_PALETTE_GREY), 0);

    if (time_str) {
        lv_label_set_text(lbl_clock, time_str);
    }
}
