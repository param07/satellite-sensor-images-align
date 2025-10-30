# Full-Stack Application — EO/SAR images Split-View Map with AOI Clip & Align

EO - Earth Observation - Refers to satellite or aerial imaging systems that capture optical, multispectral, or hyperspectral imagery of the Earth’s surface
SAR - Synthetic Aperture Radar - Refers to radar-based remote sensing satellites that use microwave signals to image the Earth
AOI - Area of Interest - In Earth Observation (EO) or Synthetic Aperture Radar (SAR) workflows, AOI refers to the specific geographic region you want to analyze or visualize — a subset of a larger satellite image.

## Overview
This project implements a full-stack geospatial processing web application that allows users to:
1. Upload two GeoTIFF images (EO/SAR data).
2. Preview them in a split-view synchronized map.
3. Draw an Area of Interest (AOI).
4. Trigger a backend processing job that:
-- Clips both images to the AOI.
-- Aligns (registers) Image B to Image A using phase cross-correlation.
5. View the processed (clipped + aligned) outputs in the same split view.

## Setup Instructions
git clone https://github.com/param07/satellite-sensor-images-align
cd satellite-sensor-images-align
docker compose up --build

This will:
Build and run all three services: web, api, and worker.

Expose:
Web UI → http://localhost:5173
Node.js API → http://localhost:8080
Python Worker → http://localhost:5000

## Run Instructions
Once all the 3 services are up
1. Open http://localhost:5173 in your browser.
2. Upload two GeoTIFF images (A and B). Upload EO file to the left and SAR file to the right
3. The maps will render in split-view (left = A, right = B).
4. Draw an AOI rectangle on the left map.
5. Click Process AOI to trigger the backend job.
6. When the job completes, select "Show processed outputs" to view the aligned results. Unselect "Show processed outputs" to view the original rendered split-view images

## Tech Stack
1. Frontend: React, Leaflet, georaster-layer-for-leaflet
2. Backend API: Node.js + Express
3. Worker Service: Python (Flask)
4. Raster Processing: GDAL, rasterio, scikit-image, numpy
5. Containerization: Docker, Docker Compose

## API Endpoints

### Upload GeoTIFF: POST /api/upload
Request = file=@example_A.tif

Response = {
  "imageId": "8d43d7f4-0a32-456d-bdcd-efb2b1a2c9c0",
  "filename": "example_A.tif",
  "size": 204800
}

### Create a Processing Job: POST /api/jobs
Request = {
  "imageAId": "8d43d7f4-0a32-456d-bdcd-efb2b1a2c9c0",
  "imageBId": "b7f3e25d-0c12-47ac-a24b-81de3ebd9077",
  "aoi": {
    "north": 12.45,
    "south": 12.15,
    "east": 77.65,
    "west": 77.25
  }
}

Response = { "jobId": "f14a4a65-98da-48cf-ae12-3b2132b61cd5" }

### Check Job Status: GET /api/jobs/:jobId
Response = {
  "jobId": "f14a4a65-98da-48cf-ae12-3b2132b61cd5",
  "status": "done",
  "progress": 100,
  "outputs": {
    "imageAUrl": "/api/outputs/f14a4a65-98da-48cf-ae12-3b2132b61cd5/A_clipped.tif",
    "imageBUrl": "/api/outputs/f14a4a65-98da-48cf-ae12-3b2132b61cd5/B_clipped_aligned.tif"
  }
}


## Application Features
1. Allows to visualize two GeoTIFFs side by side with synchronized pan and zoom.
2. Draw, edit, and reset AOI rectangles directly on the map.
3. Supports 50–150 MB GeoTIFFs. Automatically downscales very large files(file size > 150 MB) for preview using the Python downsample_raster function.
4. Node API tracks Process AOI jobs via a jobs.json file and updates progress as the Python worker clips and aligns AOI. Method used for alignment is Phase Cross-Correlation

## Application Improvements
1. We could use jobs and metadata are stored in JSON files.
2. We could use feature-based methods (e.g., SIFT + RANSAC, optical flow, or mutual information registration) that are more robust for complex transformations—though at the cost of higher computation time and heavier dependencies.

## Phase Cross-Correlation
### Features, trade-offs and limitations
1. Alignment method that estimates the translation (shift) between two images in the frequency domain.
2. Works by computing the Fourier Transform of both images, cross-correlating them, and identifying the peak correlation point to determine how much one image must be shifted (in x, y) to best align with the other.
3. Deterministic, fast, and robust to small misalignments and intensity differences
4. Works best for images with overlapping content and similar textures.
5. It cannot handle rotation, scaling, or shearing transformations.
6. If the overlap between the two AOI regions is small, the cross-correlation peak becomes ambiguous or unreliable.


