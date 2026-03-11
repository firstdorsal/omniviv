import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VehicleRenderer } from "./VehicleRenderer";

// Mock all heavy dependencies - we only test time interpolation logic
vi.mock("../map/MapLayerManager", () => ({}));
vi.mock("./VehicleIconFactory", () => ({ createVehicleIcon: () => ({}) }));
vi.mock("./vehicleModels", () => ({
    getAugsburgVehicleModel: () => ({ width: 2.4, segments: [] }),
    calculateSegmentDistances: () => [],
}));
vi.mock("./vehicleUtils", () => ({
    calculateVehiclePosition: () => null,
    createSmoothedPosition: vi.fn(),
    findPositionOnRoute: vi.fn(),
    getDebugSegmentFeatures: vi.fn(),
    getPositionAtDistance: vi.fn(),
    getPositionsBehindOnRoute: vi.fn(),
    linearizeRoute: () => null,
    updateSmoothedPosition: vi.fn(),
}));
vi.mock("./features", () => ({
    featureManager: {
        processRenderPositions: vi.fn(),
        computeSpeedAdjustments: vi.fn(() => new Map()),
    },
}));

function createMockLayerManager() {
    return {
        clearVehicleData: vi.fn(),
        updateDebugSegments: vi.fn(),
        updateVehicles: vi.fn(),
        updateVehicleModels: vi.fn(),
        addImage: vi.fn(),
    } as any;
}

describe("VehicleRenderer time interpolation", () => {
    let renderer: VehicleRenderer;
    let mockPerformanceNow: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        renderer = new VehicleRenderer(
            createMockLayerManager(),
            new Map(),
            new Map(),
        );
        mockPerformanceNow = vi.spyOn(performance, "now");
    });

    afterEach(() => {
        mockPerformanceNow.mockRestore();
    });

    it("interpolates time between React timer updates using known speed", () => {
        renderer.setTimeSpeed(1.0);

        mockPerformanceNow.mockReturnValue(1000);
        renderer.setSimulatedTime(new Date("2026-03-10T10:00:00.000Z"));

        // Frame 25ms after last React update
        mockPerformanceNow.mockReturnValue(1025);
        renderer._tick(1025);

        // Time should be interpolated: 10:00:00.000 + 25ms * 1.0 = 10:00:00.025
        const simTime = (renderer as any).simulatedTime.getTime();
        const expected = new Date("2026-03-10T10:00:00.025Z").getTime();
        expect(simTime).toBe(expected);
    });

    it("interpolates at higher speeds correctly", () => {
        renderer.setTimeSpeed(10.0);

        mockPerformanceNow.mockReturnValue(1000);
        renderer.setSimulatedTime(new Date("2026-03-10T10:00:00.000Z"));

        // Frame 16ms later at 10x speed
        mockPerformanceNow.mockReturnValue(1016);
        renderer._tick(1016);

        // Time should advance by 16ms * 10 = 160ms
        const simTime = (renderer as any).simulatedTime.getTime();
        const expected = new Date("2026-03-10T10:00:00.160Z").getTime();
        expect(simTime).toBe(expected);
    });

    it("recalculates targets every frame", () => {
        mockPerformanceNow.mockReturnValue(1000);
        renderer.setSimulatedTime(new Date("2026-03-10T10:00:00.000Z"));

        const countBefore = renderer._recalcCount;

        for (let i = 1; i <= 10; i++) {
            mockPerformanceNow.mockReturnValue(1000 + i * 16);
            renderer._tick(1000 + i * 16);
        }

        expect(renderer._recalcCount - countBefore).toBe(10);
    });

    it("time only moves forward across React corrections", () => {
        renderer.setTimeSpeed(1.0);

        mockPerformanceNow.mockReturnValue(1000);
        renderer.setSimulatedTime(new Date("2026-03-10T10:00:00.000Z"));

        // Frame just before next React update
        mockPerformanceNow.mockReturnValue(1048);
        renderer._tick(1048);
        const timeBefore = (renderer as any).simulatedTime.getTime();

        // React sends next update (50ms of simulated time)
        mockPerformanceNow.mockReturnValue(1050);
        renderer.setSimulatedTime(new Date("2026-03-10T10:00:00.050Z"));

        // Frame right after
        mockPerformanceNow.mockReturnValue(1066);
        renderer._tick(1066);
        const timeAfter = (renderer as any).simulatedTime.getTime();

        expect(timeAfter).toBeGreaterThan(timeBefore);
    });

    it("caps interpolation to prevent huge jumps after tab inactivity", () => {
        renderer.setTimeSpeed(1.0);

        mockPerformanceNow.mockReturnValue(1000);
        renderer.setSimulatedTime(new Date("2026-03-10T10:00:00.000Z"));

        // Tab inactive for 5 seconds
        mockPerformanceNow.mockReturnValue(6000);
        renderer._tick(6000);

        const advance = (renderer as any).simulatedTime.getTime() -
            new Date("2026-03-10T10:00:00.000Z").getTime();
        expect(advance).toBeLessThanOrEqual(200);
    });

    it("uses explicitly set speed, not computed from call timing", () => {
        renderer.setTimeSpeed(5.0);

        mockPerformanceNow.mockReturnValue(1000);
        renderer.setSimulatedTime(new Date("2026-03-10T10:00:00.000Z"));

        // Even though setSimulatedTime was called once, timeSpeed stays at 5.0
        expect((renderer as any).timeSpeed).toBe(5.0);

        mockPerformanceNow.mockReturnValue(1016);
        renderer._tick(1016);

        // Should advance by 16ms * 5.0 = 80ms
        const simTime = (renderer as any).simulatedTime.getTime();
        const expected = new Date("2026-03-10T10:00:00.080Z").getTime();
        expect(simTime).toBe(expected);
    });
});
