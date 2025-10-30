# worker/Dockerfile
FROM python:3.10-slim

# Install dependencies (GDAL + rasterio + skimage)
RUN apt-get update && apt-get install -y \
    gdal-bin libgdal-dev python3-gdal python3-numpy && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Default command (idle container)
CMD ["python", "server.py"]
