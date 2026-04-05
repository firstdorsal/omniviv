import { expect, type Page } from "@playwright/test";

export const MARTIN_URL = "http://omniviv-martin.localhost";

export async function waitForMap(page: Page) {
    await page.waitForFunction(() => !!(window as any).map, { timeout: 20000 });
    await page.waitForFunction(() => {
        const map = (window as any).map;
        return map && typeof map.getZoom === "function";
    }, { timeout: 10000 });
    await page.waitForTimeout(4000);
}

export async function openLayersPanel(page: Page) {
    await page.locator('button[aria-label="Ebenen"]').click();
    await expect(page.locator("text=Ebenen")).toBeVisible();
}

export async function openSettingsPanel(page: Page) {
    await page.locator('button[aria-label="Einstellungen"]').click();
    await expect(page.locator("text=Einstellungen")).toBeVisible();
}

export async function enableDebugMode(page: Page) {
    await openSettingsPanel(page);
    const toggle = page.locator("#debug-mode");
    if ((await toggle.getAttribute("data-state")) !== "checked") {
        await toggle.click();
    }
    await expect(toggle).toHaveAttribute("data-state", "checked");
}

export async function openDebugPanel(page: Page) {
    const btn = page.locator('button[aria-label="Debug"]');
    await btn.click();
    await expect(page.locator("text=Debug")).toBeVisible();
}

export async function isCheckboxChecked(page: Page, label: string): Promise<boolean> {
    const checkbox = page.locator(`label:has-text("${label}") button[role="checkbox"]`);
    return (await checkbox.getAttribute("data-state")) === "checked";
}

export async function toggleCheckbox(page: Page, label: string) {
    await page.locator(`label:has-text("${label}") button[role="checkbox"]`).click();
    await page.waitForTimeout(500);
}

export async function queryLayer(page: Page, layerId: string): Promise<{
    exists: boolean;
    visibility: string;
    featureCount: number;
}> {
    return page.evaluate((id) => {
        const map = (window as any).map;
        if (!map) return { exists: false, visibility: "no map", featureCount: -1 };
        const layer = map.getLayer(id);
        if (!layer) return { exists: false, visibility: "no layer", featureCount: 0 };
        const vis = map.getLayoutProperty(id, "visibility") ?? "visible";
        let count = 0;
        try { count = map.queryRenderedFeatures({ layers: [id] }).length; } catch { count = -1; }
        return { exists: true, visibility: vis, featureCount: count };
    }, layerId);
}
