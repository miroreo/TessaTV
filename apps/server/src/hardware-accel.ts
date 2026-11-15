import type { HardwareAccelSettings, ServerSettingsRepository } from "@tessatv/domain";
import { listRenderDevices, selectHardwareAccelByPriority, SoftwareAccel, type HardwareAccel, type HardwareAccelOptions } from "@tessatv/streaming";

export interface HardwareAccelResolverOptions {
  readonly settings: ServerSettingsRepository;
  /** Used while the admin hasn't chosen: what the `HARDWARE_ACCEL` / `VAAPI_DEVICE` variables resolved to at startup. */
  readonly environmentDefault: HardwareAccel;
  readonly probe?: HardwareAccelOptions;
  readonly onSkippedDevice?: (device: string) => void;
}

/**
 * Picks the accel for each transcode from the saved setting, so a change applies from the next
 * video without a restart. Probing a device runs several ffmpeg encodes, so the result is kept
 * until the setting changes.
 */
export class HardwareAccelResolver {
  private cached: { readonly key: string; readonly accel: Promise<HardwareAccel> } | null = null;

  constructor(private readonly options: HardwareAccelResolverOptions) {}

  async current(): Promise<HardwareAccel> {
    const { hardwareAccel } = await this.options.settings.get();
    const key = JSON.stringify(hardwareAccel);
    if (this.cached?.key !== key) this.cached = { key, accel: this.resolve(hardwareAccel) };
    return this.cached.accel;
  }

  listDevices(): Promise<string[]> {
    return listRenderDevices();
  }

  private resolve(setting: HardwareAccelSettings | null): Promise<HardwareAccel> {
    if (!setting) return Promise.resolve(this.options.environmentDefault);
    if (!setting.enabled) return Promise.resolve(new SoftwareAccel());
    return selectHardwareAccelByPriority(setting.devices, {
      ...this.options.probe,
      ...(this.options.onSkippedDevice ? { onSkip: this.options.onSkippedDevice } : {}),
    });
  }
}
