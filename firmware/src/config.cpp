#include "config.h"
#include <esp_partition.h>
#include <ArduinoJson.h>

DeviceConfig readConfig() {
    DeviceConfig config;
    config.valid = false;

    const esp_partition_t* part = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA,
        static_cast<esp_partition_subtype_t>(0x40),
        CONFIG_PARTITION_LABEL
    );

    if (!part) {
        Serial.println("Config partition not found");
        return config;
    }

    // Read magic + length header (8 bytes)
    uint8_t header[8];
    if (esp_partition_read(part, 0, header, sizeof(header)) != ESP_OK) {
        Serial.println("Failed to read config header");
        return config;
    }

    uint32_t magic = header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);
    if (magic != CONFIG_MAGIC) {
        Serial.printf("Invalid config magic: 0x%08X (expected 0x%08X)\n", magic, CONFIG_MAGIC);
        return config;
    }

    uint32_t json_len = header[4] | (header[5] << 8) | (header[6] << 16) | (header[7] << 24);
    if (json_len == 0 || json_len > 4000) {
        Serial.printf("Invalid config JSON length: %u\n", json_len);
        return config;
    }

    // Read JSON payload
    char* json_buf = new char[json_len + 1];
    if (esp_partition_read(part, 8, json_buf, json_len) != ESP_OK) {
        Serial.println("Failed to read config JSON");
        delete[] json_buf;
        return config;
    }
    json_buf[json_len] = '\0';

    // Parse JSON
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, json_buf, json_len);
    delete[] json_buf;

    if (err) {
        Serial.printf("Config JSON parse error: %s\n", err.c_str());
        return config;
    }

    if (!doc["wifi_ssid"].is<const char*>() || !doc["wifi_password"].is<const char*>() ||
        !doc["api_url"].is<const char*>() || !doc["stop_ifopt"].is<const char*>()) {
        Serial.println("Config JSON missing required fields");
        return config;
    }

    config.wifi_ssid = doc["wifi_ssid"].as<String>();
    config.wifi_password = doc["wifi_password"].as<String>();
    config.api_url = doc["api_url"].as<String>();
    config.stop_ifopt = doc["stop_ifopt"].as<String>();
    config.valid = true;

    Serial.printf("Config loaded: SSID=%s, API=%s, Stop=%s\n",
                  config.wifi_ssid.c_str(), config.api_url.c_str(), config.stop_ifopt.c_str());

    return config;
}

bool writeConfig(const DeviceConfig& config) {
    // Serialize to JSON
    JsonDocument doc;
    doc["wifi_ssid"] = config.wifi_ssid;
    doc["wifi_password"] = config.wifi_password;
    doc["api_url"] = config.api_url;
    doc["stop_ifopt"] = config.stop_ifopt;

    String json;
    serializeJson(doc, json);
    uint32_t json_len = json.length();

    if (json_len > 4000) {
        Serial.println("Config JSON too large to write");
        return false;
    }

    // Build binary blob: 4-byte magic + 4-byte length + JSON + 0xFF padding
    const size_t BLOB_SIZE = 4096;
    uint8_t* buf = new uint8_t[BLOB_SIZE];
    memset(buf, 0xFF, BLOB_SIZE);

    // Magic: "OMNI" as little-endian uint32
    buf[0] = 0x4F; // 'O'
    buf[1] = 0x4D; // 'M'
    buf[2] = 0x4E; // 'N'
    buf[3] = 0x49; // 'I'

    // JSON length as little-endian uint32
    buf[4] = (json_len >>  0) & 0xFF;
    buf[5] = (json_len >>  8) & 0xFF;
    buf[6] = (json_len >> 16) & 0xFF;
    buf[7] = (json_len >> 24) & 0xFF;

    // JSON payload
    memcpy(buf + 8, json.c_str(), json_len);

    // Find config partition
    const esp_partition_t* part = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA,
        static_cast<esp_partition_subtype_t>(0x40),
        CONFIG_PARTITION_LABEL
    );

    if (!part) {
        Serial.println("Config partition not found for writing");
        delete[] buf;
        return false;
    }

    // Erase before write (required for flash)
    esp_err_t err = esp_partition_erase_range(part, 0, part->size);
    if (err != ESP_OK) {
        Serial.printf("Config partition erase failed: %s\n", esp_err_to_name(err));
        delete[] buf;
        return false;
    }

    // Write the blob
    err = esp_partition_write(part, 0, buf, BLOB_SIZE);
    delete[] buf;

    if (err != ESP_OK) {
        Serial.printf("Config partition write failed: %s\n", esp_err_to_name(err));
        return false;
    }

    Serial.println("Config written successfully");
    return true;
}
