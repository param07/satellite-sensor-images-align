from flask import Flask, request, jsonify
import os
import traceback
from worker_downsample import downsample_raster, update_meta
from worker import main as process_aoi_main
import subprocess

app = Flask(__name__)

@app.route("/downsample", methods=["POST"])
def downsample():
    try:
        data = request.json
        input_path = data["input"]
        output_path = data["output"]
        scale = float(data.get("scale", 0.25))
        meta_path = data.get("meta")

        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        downsample_raster(input_path, output_path, scale)

        if meta_path:
            update_meta(meta_path, status="ready", preview_filename=os.path.basename(output_path))

        return jsonify({"status": "ok", "output": output_path})
    except Exception as e:
        tb = traceback.format_exc()
        print("[worker/downsample] ERROR", tb)
        if data.get("meta"):
            update_meta(meta_path, status="error", error_msg=str(e))
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/process_aoi", methods=["POST"])
def process_aoi():
    """
    Executes the same logic as worker.py for clipping + alignment.
    """
    try:
        data = request.json
        image_a = data["imageA"]
        image_b = data["imageB"]
        aoi = data["aoi"]
        out_dir = data["outDir"]
        job_id = data.get("jobId", "local")

        os.makedirs(out_dir, exist_ok=True)

        cmd = [
            "python", "worker.py",
            "--image_a", image_a,
            "--image_b", image_b,
            "--aoi", f"north={aoi['north']};south={aoi['south']};east={aoi['east']};west={aoi['west']}",
            "--out_dir", out_dir,
            "--jobid", job_id
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print("[worker/process_aoi] ERROR:", result.stderr)
            return jsonify({"status": "error", "message": result.stderr}), 500

        return jsonify({"status": "done", "outputDir": out_dir})
    except Exception as e:
        tb = traceback.format_exc()
        print("[worker/process_aoi] ERROR", tb)
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/clip", methods=["POST"])
def clip():
    """
    Optional: A simpler endpoint to clip one image to AOI.
    """
    try:
        data = request.json
        image = data["image"]
        aoi = data["aoi"]
        out_path = data["output"]
        cmd = [
            "python", "worker.py",
            "--image_a", image,
            "--image_b", image,  # placeholder
            "--aoi", f"north={aoi['north']};south={aoi['south']};east={aoi['east']};west={aoi['west']}",
            "--out_dir", os.path.dirname(out_path)
        ]
        subprocess.run(cmd)
        return jsonify({"status": "ok", "output": out_path})
    except Exception as e:
        tb = traceback.format_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
