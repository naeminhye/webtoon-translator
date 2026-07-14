/**
 * bench/lib/env.js — environment capture per benchmark-plan.md's
 * "Methodology": browser+version, hardwareConcurrency, deviceMemory, GPU
 * adapter info, OS, crossOriginIsolated, ORT Web version.
 *
 * Vendored ORT version isn't exposed at runtime by onnxruntime-web's UMD
 * build in this vendoring setup, so it's read from package.json's pin
 * instead — bump ORT_VERSION alongside package.json's onnxruntime-web and
 * extension/vendor/ort/ whenever the vendored build is upgraded.
 */
const ORT_VERSION = '1.18.0';

export async function captureEnvironment() {
  let gpuAdapterInfo = null;
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        // Mirrors ort-runner.js's requestAdapterInfo()/info polyfill note —
        // newer Chrome moved from the async method to a plain property.
        const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
        gpuAdapterInfo = info
          ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }
          : { note: 'adapter present but no info available' };
      } else {
        gpuAdapterInfo = { note: 'navigator.gpu present but requestAdapter() returned null' };
      }
    } catch (err) {
      gpuAdapterInfo = { error: String(err.message || err) };
    }
  }

  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated === true : null,
    gpuAdapterInfo,
    ortVersion: ORT_VERSION,
  };
}
