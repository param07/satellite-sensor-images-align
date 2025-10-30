import argparse
import rasterio
from rasterio.enums import Resampling
from rasterio.io import MemoryFile
import os
import json
import traceback


def downsample_raster(input_path, output_path, scale):
    with rasterio.open(input_path) as src:
        # Compute target shape
        new_height = int(src.height * scale)
        new_width = int(src.width * scale)

        # Guardrails
        if new_height < 1 or new_width < 1:
            raise ValueError("Scale too small, image would collapse")

        # Define transform for new resolution
        transform = src.transform * src.transform.scale(
            src.width / new_width,
            src.height / new_height
        )

        kwargs = src.meta.copy()
        kwargs.update({
            "height": new_height,
            "width": new_width,
            "transform": transform,
            "dtype": "uint8",  # <-- Force 8-bit
            "count": src.count,
            "compress": "lzw"
        })

        with rasterio.open(output_path, "w", **kwargs) as dst:
            for i in range(1, src.count + 1):
                data = src.read(
                    i,
                    out_shape=(new_height, new_width),
                    resampling=Resampling.average
                )
                
                # Normalize band data for display (0–255)
                data = data.astype(float)
                data_min, data_max = data.min(), data.max()
                if data_max > data_min:
                    data = 255 * (data - data_min) / (data_max - data_min)
                data = data.astype("uint8")

                dst.write(data, i)

    print(f"[OK] Downsampled to {output_path} ({new_width}×{new_height})")


def update_meta(meta_path, status, preview_filename=None, error_msg=None):
    try:
        if not os.path.exists(meta_path):
            print("[worker] meta not found:", meta_path)
            return
        with open(meta_path, 'r') as f:
            meta = json.load(f)
    except Exception as e:
        print("[worker] failed to read meta:", e)
        return

    if preview_filename is not None:
        meta['previewFileName'] = preview_filename
    meta['status'] = status
    meta['error'] = error_msg

    try:
        with open(meta_path, 'w') as f:
            json.dump(meta, f, indent=2)
    except Exception as e:
        print("[worker] failed to write meta:", e)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scale", type=float, default=0.25)
    parser.add_argument("--meta", required=False, help="Path to JSON metadata to update")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    meta_path = args.meta
    # downsample_raster(args.input, args.output, args.scale)
    try:
        downsample_raster(args.input, args.output, args.scale)

        # If worker succeeded, update meta to ready
        if meta_path:
            update_meta(meta_path, status="ready", preview_filename=os.path.basename(args.output), error_msg=None)

        print("[worker] success")
    except Exception as e:
        tb = traceback.format_exc()
        print("[worker] downsample failed:", str(e))
        print(tb)
        if meta_path:
            update_meta(meta_path, status="error", preview_filename=None, error_msg=str(e))
        # exit with non-zero code to indicate failure
        raise