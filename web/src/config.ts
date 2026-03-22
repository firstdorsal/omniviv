export interface AppConfig {
    apiUrl: string;
    martinUrl: string;
    motisUrl: string;
}

let config: AppConfig | null = null;
let configPromise: Promise<AppConfig> | null = null;

const defaultConfig: AppConfig = {
    apiUrl: import.meta.env.VITE_API_URL ?? "http://localhost:3000",
    martinUrl: import.meta.env.VITE_MARTIN_URL ?? "http://localhost:3001",
    motisUrl: import.meta.env.VITE_MOTIS_URL ?? "http://omniviv-motis.localhost",
};

export async function loadConfig(): Promise<AppConfig> {
    if (config) {
        return config;
    }

    if (configPromise) {
        return configPromise;
    }

    configPromise = (async () => {
        try {
            const response = await fetch("/config.json");
            if (!response.ok) {
                console.warn("Failed to load config.json, using defaults");
                config = defaultConfig;
                return config;
            }
            const data = await response.json();
            config = {
                apiUrl: data.apiUrl ?? defaultConfig.apiUrl,
                martinUrl: data.martinUrl ?? defaultConfig.martinUrl,
                motisUrl: data.motisUrl ?? defaultConfig.motisUrl,
            };
            return config;
        } catch (error) {
            console.warn("Error loading config.json, using defaults:", error);
            config = defaultConfig;
            return config;
        }
    })();

    return configPromise;
}

export function getConfig(): AppConfig {
    if (!config) {
        throw new Error("Config not loaded. Call loadConfig() first.");
    }
    return config;
}

export function getConfigSync(): AppConfig | null {
    return config;
}
