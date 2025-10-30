"""
Clips image A and image B to AOI and aligns B->A using phase_cross_correlation (translation).
Writes outputs: A_clipped.tif, B_clipped_aligned.tif in out_dir.

CLI args:
  --image_a /data/uploads/xxx.tif
  --image_b /data/uploads/yyy.tif
  --aoi "north=..;south=..;east=..;west=.."
  --out_dir /data/outputs/<jobId>
  --jobid <jobId>  (optional, used for logging)
  --jobs_file <path-to-jobs.json> (optional, used if you want worker to update jobs.json)
"""

import argparse
import os
import sys
import json
import numpy as np
import rasterio
from rasterio.warp import transform_bounds, calculate_default_transform, reproject, Resampling
from rasterio.mask import mask
from rasterio.enums import Resampling as RIOResampling
from affine import Affine
from skimage.registration import phase_cross_correlation
from skimage.transform import warp
import warnings
warnings.filterwarnings("ignore")

def log(msg):
    print(msg)
    sys.stdout.flush()

def emit_progress(p):
    # prints a progress token server can parse e.g. "PROGRESS: 20"
    print(f"PROGRESS: {int(p)}")
    sys.stdout.flush()

def parse_aoi(aoi_str):
    # accepts "north=..;south=..;east=..;west=.."
    parts = {}
    for kv in aoi_str.split(';'):
        if not kv: continue
        k, v = kv.split('=')
        parts[k.strip()] = float(v)
    return parts

def clip_to_aoi(src_path, aoi4326, out_path=None, reference_crs='EPSG:4326', target_bounds=None):
    """
    Clip src_path to AOI in EPSG:4326.
    If target_bounds (in target CRS) are given, clip to that exact rectangle.
    Returns (array, meta) for the clipped raster.
    """
    with rasterio.open(src_path) as src:
        if target_bounds is not None:
            # Use predefined bounds (in src.crs units)
            left, bottom, right, top = target_bounds
        else:
            # Transform AOI from EPSG:4326 to raster CRS
            left, bottom, right, top = transform_bounds(
                reference_crs, src.crs,
                aoi4326['west'], aoi4326['south'],
                aoi4326['east'], aoi4326['north'],
                densify_pts=21
            )

        window_geom = [{
            "type": "Polygon",
            "coordinates": [[
                [left, bottom], [right, bottom], [right, top],
                [left, top], [left, bottom]
            ]]
        }]

        try:
            out_image, out_transform = mask(src, window_geom, crop=True, all_touched=True)
        except ValueError:
            # AOI outside extent — return blank image covering AOI
            width = src.width
            height = src.height
            out_image = np.zeros((src.count, 1, 1), dtype=src.dtypes[0])
            out_transform = src.transform

        out_meta = src.meta.copy()
        out_meta.update({
            "driver": "GTiff",
            "height": out_image.shape[1],
            "width": out_image.shape[2],
            "transform": out_transform
        })
        return out_image, out_meta


def compute_translation(reference_arr, moving_arr):
    """
    Convert arrays to grayscale float and compute shift (y,x) using phase_cross_correlation.
    Returns the shift vector (shift_y, shift_x).
    """
    # Use first band if multiband
    if reference_arr.ndim == 3:
        ref = reference_arr[0].astype(np.float32)
    else:
        ref = reference_arr.astype(np.float32)
    if moving_arr.ndim == 3:
        mov = moving_arr[0].astype(np.float32)
    else:
        mov = moving_arr.astype(np.float32)

    # If data dynamic range is large, normalize
    def norm(a):
        a = a - np.nanmin(a)
        mx = np.nanmax(a)
        if mx > 0:
            a = a / mx
        return a
    refn = norm(ref)
    movn = norm(mov)

    # If sizes differ, pad the smaller to match larger
    if refn.shape != movn.shape:
        # pad both to common shape (max)
        maxr = max(refn.shape[0], movn.shape[0])
        maxc = max(refn.shape[1], movn.shape[1])
        newref = np.zeros((maxr, maxc), dtype=refn.dtype)
        newmov = np.zeros((maxr, maxc), dtype=movn.dtype)
        newref[:refn.shape[0], :refn.shape[1]] = refn
        newmov[:movn.shape[0], :movn.shape[1]] = movn
        refn, movn = newref, newmov

    shift, error, diffphase = phase_cross_correlation(refn, movn, upsample_factor=10)
    # shift is (y, x) meaning mov should be shifted by this to align to ref
    return shift  # (shift_y, shift_x)

def apply_translation_and_write(moving_img, moving_meta, shift, out_path, reference_shape=None):
    """
    Apply a translation to moving_img (numpy bands, h, w) using the shift (y, x)
    and write a GeoTIFF using moving_meta updated transform.
    This uses an Affine translation on the transform to move pixels.
    """
    shift_y, shift_x = shift
    # pixel shift -> world shift = shift_x * pixel_width, shift_y * (-pixel_height)
    # update transform by translating origin in world coordinates
    transform = moving_meta['transform']
    # compute world offset:
    pixel_width = transform.a
    pixel_height = -transform.e  # negative usually
    world_dx = shift_x * pixel_width
    world_dy = -shift_y * pixel_height  # minus because image rows go down

    new_transform = Affine(transform.a, transform.b, transform.c + world_dx,
                           transform.d, transform.e, transform.f + world_dy)

    out_meta = moving_meta.copy()
    out_meta.update({"transform": new_transform})

    # write output
    with rasterio.open(out_path, 'w', **out_meta) as dst:
        for i in range(1, moving_img.shape[0] + 1):

            dst.write(moving_img[i-1], i)

def normalize_bands(data):
    """Normalize each band (0–255, uint8)."""
    data = data.astype(float)
    for i in range(data.shape[0]):
        band = data[i]
        bmin, bmax = np.nanmin(band), np.nanmax(band)
        if bmax > bmin:
            band = 255 * (band - bmin) / (bmax - bmin)
        data[i] = band
    return data.astype("uint8")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image_a', required=True)
    parser.add_argument('--image_b', required=True)
    parser.add_argument('--aoi', required=True, help='north=..;south=..;east=..;west=..')
    parser.add_argument('--out_dir', required=True)
    parser.add_argument('--jobid', default=None)
    parser.add_argument('--jobs_file', default=None, help='(optional) path to jobs.json to annotate progress')
    args = parser.parse_args()

    jobid = args.jobid or 'local'
    out_dir = args.out_dir
    os.makedirs(out_dir, exist_ok=True)

    try:
        log(f"[{jobid}] Starting worker")
        emit_progress(5)
        aoi = parse_aoi(args.aoi)  # dict with north, south, east, west

        log(f"[{jobid}] Clipping image A")
        A_clipped_arr, A_meta = clip_to_aoi(args.image_a, aoi)
        outA = os.path.join(out_dir, 'A_clipped.tif')
        with rasterio.open(outA, 'w', **A_meta) as dst:
            for i in range(1, A_clipped_arr.shape[0] + 1):
                dst.write(A_clipped_arr[i - 1], i)

        emit_progress(25)

        # --- Compute AOI bounds in A’s CRS for consistent clipping ---
        with rasterio.open(args.image_a) as srcA:
            a_bounds_in_A = transform_bounds(
                'EPSG:4326', srcA.crs,
                aoi['west'], aoi['south'], aoi['east'], aoi['north']
            )

        # --- Transform those bounds into B’s CRS ---
        with rasterio.open(args.image_b) as srcB:
            a_bounds_in_B = transform_bounds(srcA.crs, srcB.crs, *a_bounds_in_A)

        # --- Clip B using transformed AOI (aligned ground region) ---
        log(f"[{jobid}] Clipping image B (aligned to A’s AOI)")
        B_clipped_arr, B_meta = clip_to_aoi(args.image_b, aoi, None,reference_crs='EPSG:4326', target_bounds=a_bounds_in_B)
        outB_initial = os.path.join(out_dir, 'B_clipped_initial.tif')
        with rasterio.open(outB_initial, 'w', **B_meta) as dst:
            for i in range(1, B_clipped_arr.shape[0] + 1):
                dst.write(B_clipped_arr[i - 1], i)
        emit_progress(45)

        # Compute translation using the first band arrays
        log(f"[{jobid}] Computing translation (phase_cross_correlation)")
        shift = compute_translation(A_clipped_arr, B_clipped_arr)  # (y, x)
        log(f"[{jobid}] Detected shift (y, x) = {shift}")
        emit_progress(65)

        # Apply translation to B (modify transform and write B_clipped_aligned.tif)
        outB_aligned = os.path.join(out_dir, 'B_clipped_aligned.tif')
        B_norm = normalize_bands(B_clipped_arr)
        apply_translation_and_write(B_norm, B_meta, shift, outB_aligned)
        emit_progress(90)

        # finalization
        emit_progress(100)
        log(f"[{jobid}] Done — wrote {outA} and {outB_aligned}")
        # exit 0
        sys.exit(0)

    except Exception as e:
        import traceback
        log(f"[{jobid}] ERROR: {str(e)}")
        traceback.print_exc()
        emit_progress(100)
        sys.exit(1)


if __name__ == '__main__':
    main()
