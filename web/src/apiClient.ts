import { Api } from "./api";
import { getConfig } from "./config";

let instance: Api<unknown> | null = null;

/**
 * Get the shared API client instance, lazily initialized from config.
 */
export function getApiClient(): Api<unknown> {
    if (!instance) {
        instance = new Api({ baseUrl: getConfig().apiUrl });
    }
    return instance;
}
