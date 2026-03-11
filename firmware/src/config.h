#pragma once

#include <Arduino.h>

// Magic bytes: "OMNI" (0x4F 0x4D 0x4E 0x49)
#define CONFIG_MAGIC 0x494E4D4F
#define CONFIG_PARTITION_LABEL "config"

struct DeviceConfig {
    String wifi_ssid;
    String wifi_password;
    String api_url;
    String stop_ifopt;
    bool valid;
};

// Read device configuration from the config flash partition
DeviceConfig readConfig();

// Write device configuration to the config flash partition
// Returns true on success, false on failure
bool writeConfig(const DeviceConfig& config);
