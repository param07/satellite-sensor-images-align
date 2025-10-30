import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.sync";
import parseGeoraster from "georaster";
import GeoRasterLayer from "georaster-layer-for-leaflet";

import "leaflet-draw";
import "leaflet-draw/dist/leaflet.draw.css";

const API_BASE = "http://localhost:8080/api";
const BACK_URL = "http://localhost:8080";

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchRasterWithPolling(imageRef, jobId = null, which = null, maxRetries = 40, intervalMs = 2000) {
    let url;
    if (jobId && which) {
        // processed output (A or B)
        url = `${API_BASE}/rasters/clip/${jobId}/${which}`;
    } else {
        // uploaded original
        const isUrl = typeof imageRef === "string" &&
            (imageRef.startsWith("http://") || imageRef.startsWith("https://") || imageRef.startsWith("/"));
        url = isUrl ? `${BACK_URL}${imageRef}` : `${API_BASE}/rasters/${imageRef}.tif`;
    }

    let tries = 0;
    while (tries < maxRetries) {
        const res = await fetch(url);
        if (res.status === 200) {
            const arrayBuffer = await res.arrayBuffer();
            return arrayBuffer;
        }
        if (res.status === 202) {
            tries++;
            await sleep(intervalMs);
            continue;
        }
        const text = await res.text();
        throw new Error(`Failed to fetch raster. HTTP ${res.status} — ${text}`);
    }
    throw new Error("Timeout while waiting for raster preview");
}

function SplitMapView({ imageA, imageB }) {

    const leftMapRef = useRef(null);
    const rightMapRef = useRef(null);
    const leftDivRef = useRef(null);
    const rightDivRef = useRef(null);

    const [ready, setReady] = useState(false);
    const [loading, setLoading] = useState(false);

    // AOI state
    const [aoiBounds, setAoiBounds] = useState(null); // { north, south, east, west }
    const aoiLayerRef = useRef(null);

    // Job state
    const [jobId, setJobId] = useState(null);
    const [jobStatus, setJobStatus] = useState(null); // pending, running, error, done, idle
    const [jobError, setJobError] = useState(null);
    const [jobOutputs, setJobOutputs] = useState(null); // { imageAUrl, imageBUrl }
    const [pollIntervalId, setPollIntervalId] = useState(null);

    // When true, show processed outputs instead of raw uploaded rasters (if available)
    const [showProcessed, setShowProcessed] = useState(false);

    const [jobProgress, setJobProgress] = useState(0);
    const [rendering, setRendering] = useState(false);

    function initSyncWhenBothReady(leftMap, rightMap) {
        let leftReady = false, rightReady = false;

        leftMap.whenReady(() => {
            leftReady = true;
            if (rightReady) doSync();
        });
        rightMap.whenReady(() => {
            rightReady = true;
            if (leftReady) doSync();
        });

        function doSync() {
            try {
                if (!leftMap.getContainer() || !rightMap.getContainer()) return;
                if (!leftMap._loaded || !rightMap._loaded) return;
                leftMap.sync(rightMap);
                rightMap.sync(leftMap);
                setReady(true);
            } catch (err) {
                console.error("Sync init failed", err);
            }
        }
    }

    // Step 1 — Initialize maps

    useEffect(() => {

        if (leftMapRef.current || rightMapRef.current) return;

        // Base Layer
        const base = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: "&copy; OpenStreetMap contributors"
        });

        // Initialize two maps side by side
        const leftMap = L.map(leftDivRef.current, {
            center: [0, 0],
            zoom: 2,
            layers: [base]
        });

        const rightMap = L.map(rightDivRef.current, {
            center: [0, 0],
            zoom: 2,
            layers: [base]
        });

        initSyncWhenBothReady(leftMap, rightMap);

        // Store refs
        leftMapRef.current = leftMap;
        rightMapRef.current = rightMap;

        // add draw control to left map (single place to draw AOI)
        const drawControl = new L.Control.Draw({
            draw: {
                marker: false,
                polyline: false,
                polygon: false,
                circle: false,
                circlemarker: false,
                rectangle: {
                    shapeOptions: { color: "#ff7800", weight: 1 }
                }
            },
            edit: {
                featureGroup: new L.FeatureGroup()
            }
        });
        leftMap.addControl(drawControl);

        const drawnItems = new L.FeatureGroup();
        leftMap.addLayer(drawnItems);

        leftMap.on(L.Draw.Event.CREATED, (e) => {
            // remove existing AOI rectangle and add new one
            drawnItems.clearLayers();
            const layer = e.layer || e.propagatedFrom;
            drawnItems.addLayer(layer);

            // store reference for later remove/reset
            if (aoiLayerRef.current) aoiLayerRef.current = null;
            aoiLayerRef.current = layer;

            const bounds = layer.getBounds();
            const aoi = {
                north: bounds.getNorth(),
                south: bounds.getSouth(),
                east: bounds.getEast(),
                west: bounds.getWest()
            };
            setAoiBounds(aoi);
        });

        leftMap.on(L.Draw.Event.EDITED, (e) => {
            // handle edits to rectangle
            const layers = e.layers;
            layers.eachLayer((layer) => {
                const bounds = layer.getBounds();
                const aoi = {
                    north: bounds.getNorth(),
                    south: bounds.getSouth(),
                    east: bounds.getEast(),
                    west: bounds.getWest()
                };
                setAoiBounds(aoi);
                aoiLayerRef.current = layer;
            });
        });

        leftMap.on(L.Draw.Event.DELETED, () => {
            setAoiBounds(null);
            aoiLayerRef.current = null;
        });

        return () => {
            // Unsync first to prevent _leaflet_pos errors
            try {
                if (leftMapRef.current && rightMapRef.current) {
                    leftMapRef.current.unsync(rightMapRef.current);
                    rightMapRef.current.unsync(leftMapRef.current);
                }
            } catch (e) {
                console.warn("Unsync cleanup issue:", e);
            }

            try {
                if (leftMapRef.current) {
                    leftMapRef.current.eachLayer(l => {
                        if (!(l instanceof L.TileLayer)) leftMapRef.current.removeLayer(l);
                    });
                    leftMapRef.current.remove();
                    leftMapRef.current = null;
                }
                if (rightMapRef.current) {
                    rightMapRef.current.eachLayer(l => {
                        if (!(l instanceof L.TileLayer)) rightMapRef.current.removeLayer(l);
                    });
                    rightMapRef.current.remove();
                    rightMapRef.current = null;
                }
            } catch (e) {
                console.warn("Map destroy error:", e);
            }
        };
    }, []);


    // STEP 2 — Load rasters based on toggle (original vs processed)
    useEffect(() => {
        if (!ready || !imageA || !imageB) return;

        let cancelled = false;
        let layerA, layerB;

        async function addLayers() {
            setLoading(true);
            const mapA = leftMapRef.current;
            const mapB = rightMapRef.current;

            // Remove all non-tile layers
            mapA.eachLayer(l => { if (!(l instanceof L.TileLayer)) mapA.removeLayer(l); });
            mapB.eachLayer(l => { if (!(l instanceof L.TileLayer)) mapB.removeLayer(l); });

            try {
                let arrayBufferA, arrayBufferB;

                if (showProcessed && jobId && jobStatus === "done" && jobOutputs) {
                    // processed outputs
                    arrayBufferA = await fetchRasterWithPolling(null, jobId, "A");
                    arrayBufferB = await fetchRasterWithPolling(null, jobId, "B");
                } else {
                    // original rasters
                    arrayBufferA = await fetchRasterWithPolling(imageA.imageId);
                    arrayBufferB = await fetchRasterWithPolling(imageB.imageId);
                }

                const georasterA = await parseGeoraster(arrayBufferA);
                const georasterB = await parseGeoraster(arrayBufferB);

                layerA = new GeoRasterLayer({ georaster: georasterA, opacity: 0.95, resolution: 256 });
                layerB = new GeoRasterLayer({ georaster: georasterB, opacity: 0.95, resolution: 256 });

                layerA.addTo(mapA);
                layerB.addTo(mapB);

                const boundsA = layerA.getBounds();
                const boundsB = layerB.getBounds();
                if (boundsA && boundsB) {
                    const union = boundsA.extend(boundsB);
                    mapA.fitBounds(union);
                    mapB.fitBounds(union);
                }
            } catch (err) {
                console.error("Error loading GeoTIFF:", err);
                alert("Failed to render GeoTIFF: " + err.message);
            } finally {
                if (!cancelled) {
                    setLoading(false);
                    if (rendering) setRendering(false);
                };
            }
        }

        addLayers();

        return () => {
            cancelled = true;
            if (layerA && leftMapRef.current) leftMapRef.current.removeLayer(layerA);
            if (layerB && rightMapRef.current) rightMapRef.current.removeLayer(layerB);
        };
    }, [ready, imageA, imageB, showProcessed, jobStatus, jobId]);


    // AOI reset handler (removes rectangle)
    function resetAoi() {
        if (aoiLayerRef.current && leftMapRef.current) {
            // const fg = new L.FeatureGroup();
            // fg.addLayer(aoiLayerRef.current);
            // fg.removeLayer(aoiLayerRef.current);
            // Simpler: remove from map directly
            leftMapRef.current.eachLayer((l) => {
                if (l instanceof L.Rectangle) leftMapRef.current.removeLayer(l);
            });
            aoiLayerRef.current = null;
            setAoiBounds(null);
        } else {
            setAoiBounds(null);
        }
        setJobStatus("Idle");
    }

    // Kick off job: POST /api/jobs
    async function processAoi() {
        if (!aoiBounds) {
            alert("Please draw an AOI rectangle first.");
            return;
        }
        if (!imageA || !imageB) {
            alert("Missing images.");
            return;
        }

        // disable UI by setting status to pending
        setJobStatus("pending");
        setJobError(null);
        setJobOutputs(null);
        setJobId(null);

        try {
            const payload = {
                imageAId: imageA.imageId,
                imageBId: imageB.imageId,
                aoi: aoiBounds
            };
            const res = await fetch(`${API_BASE}/jobs`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (!res.ok) {
                const t = await res.text();
                throw new Error(`Job submit failed ${res.status} — ${t}`);
            }
            const data = await res.json();
            const jid = data.jobId;
            setJobId(jid);
            setJobStatus("pending");

            // start polling
            const id = setInterval(() => pollJob(jid), 2000);
            setPollIntervalId(id);
        } catch (err) {
            console.error("Process submit failed", err);
            setJobStatus("error");
            setJobError(err.message || String(err));
        }
    }

    // Poll job status GET /api/jobs/:jobId
    async function pollJob(jid) {
        try {
            const res = await fetch(`${API_BASE}/jobs/${jid}`);
            if (res.status === 404) {
                setJobStatus("error");
                setJobError("Job not found");
                if (pollIntervalId) {
                    clearInterval(pollIntervalId);
                    setPollIntervalId(null);
                };
                return;
            }
            const data = await res.json();
            const s = (data.status || "").toLowerCase();
            if (typeof data.progress === "number") setJobProgress(data.progress);
            // map server states to frontend states
            if (s === "pending" || s === "queued") {
                setJobStatus("pending");
                return;
            }
            if (s === "running") {
                setJobStatus("running");
                return;
            }
            if (s === "error" || data.error) {
                setJobStatus("error");
                setJobError(data.error || "Processing error");
                if (pollIntervalId) { clearInterval(pollIntervalId); setPollIntervalId(null); }
                return;
            }
            if (s === "done" || s === "finished" || data.outputs) {
                setJobStatus("done");
                setJobOutputs(data.outputs || null);
                setJobProgress(100);
                if (pollIntervalId) { clearInterval(pollIntervalId); setPollIntervalId(null); }
                return;
            }
            
            setJobStatus(s || data.status);
        } catch (err) {
            console.warn("pollJob failed", err);
        }
    }

    // cleanup poll on unmount
    useEffect(() => {
        return () => {
            if (pollIntervalId) clearInterval(pollIntervalId);
        };
    }, [pollIntervalId]);

    // UI: simple status chip color
    function StatusChip({ status }) {
        const style = {
            padding: "6px 8px",
            borderRadius: 8,
            display: "inline-block",
            minWidth: 80,
            textAlign: "center",
            fontWeight: 600,
        };
        if (!status) {
            return <div style={{ ...style, background: "#eee" }}>Idle</div>;
        }
        if (status === "pending") return <div style={{ ...style, background: "#ffeeba" }}>Pending</div>;
        if (status === "running") return <div style={{ ...style, background: "#cce5ff" }}>Running</div>;
        if (status === "done") return <div style={{ ...style, background: "#d4edda" }}>Done</div>;
        if (status === "error") return <div style={{ ...style, background: "#f8d7da" }}>Error</div>;
        return <div style={style}>{status}</div>;
    }

    return (
        <div style={{ position: "relative" }}>
            {/* Global page overlay while loading */}
            {((loading || jobStatus === "pending" || jobStatus === "running") && jobStatus !== "done") && (
                <div
                    style={{
                        position: "fixed",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: "100%",
                        background: "rgba(255, 255, 255, 0.7)",
                        zIndex: 2000,
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "center",
                        alignItems: "center",
                        pointerEvents: "auto",
                    }}
                >
                    <div
                        style={{
                            background: "white",
                            padding: "20px 30px",
                            borderRadius: "10px",
                            boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
                            minWidth: "300px",
                            textAlign: "center",
                        }}
                    >
                        <div style={{ fontWeight: 600, marginBottom: 10 }}>
                            {jobStatus === "done"
                                ? "Rendering processed outputs…"
                                : jobStatus === "running"
                                    ? "Processing AOI…"
                                    : jobStatus === "pending"
                                        ? "Queued…"
                                        : "Rendering… please wait"}
                        </div>
                        {jobStatus === "running" && (
                            <div style={{
                                width: "100%",
                                height: "10px",
                                background: "#eee",
                                borderRadius: "5px",
                                overflow: "hidden",
                                marginBottom: "10px"
                            }}>
                                <div
                                    style={{
                                        width: `${jobProgress}%`,
                                        height: "100%",
                                        background: "#007bff",
                                        transition: "width 0.5s ease"
                                    }}
                                />
                            </div>
                        )}
                        <div style={{ fontSize: 13, color: "#666" }}>
                            {jobProgress ? `Progress: ${jobProgress.toFixed(0)}%` : ""}
                        </div>
                    </div>
                </div>
            )}

            {rendering && (
                <div
                    style={{
                        position: "fixed",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: "100%",
                        background: "rgba(255, 255, 255, 0.7)",
                        zIndex: 2000,
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "center",
                        alignItems: "center",
                        pointerEvents: "auto",
                    }}
                >
                    <div
                        style={{
                            background: "white",
                            padding: "20px 30px",
                            borderRadius: "10px",
                            boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
                            minWidth: "300px",
                            textAlign: "center",
                        }}
                    >
                        <div style={{ fontWeight: 600, marginBottom: 10 }}>
                            Rendering… please wait
                        </div>
                    </div>
                </div>
            )}


            {/* Controls row */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <div style={{ display: "flex", flexDirection: "column" }}>
                        <div><strong>AOI:</strong></div>
                        <div style={{ fontFamily: "monospace", fontSize: 13 }}>
                            {aoiBounds ? (
                                <>
                                    N: {aoiBounds.north.toFixed(6)} &nbsp; S: {aoiBounds.south.toFixed(6)} &nbsp;
                                    E: {aoiBounds.east.toFixed(6)} &nbsp; W: {aoiBounds.west.toFixed(6)}
                                </>
                            ) : (
                                <em>Draw rectangle on left map (use draw tool)</em>
                            )}
                        </div>
                    </div>

                    <button onClick={resetAoi} disabled={!aoiBounds || loading}>Reset AOI</button>

                    <button
                        onClick={processAoi}
                        disabled={
                            loading ||
                            !aoiBounds ||
                            !imageA ||
                            !imageB ||
                            jobStatus === "pending" ||
                            jobStatus === "running"
                        }
                    >
                        {jobStatus === "pending" || jobStatus === "running"
                            ? "Processing…"
                            : "Process AOI"}
                    </button>

                    <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                        <StatusChip status={jobStatus} />
                        {jobError && <div style={{ color: "crimson" }}>Error: {jobError}</div>}
                    </div>
                </div>

                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                            type="checkbox"
                            checked={showProcessed}
                            onChange={() => {
                                if (jobStatus === "done" && jobOutputs && jobId) {
                                    setRendering(true);
                                    setShowProcessed(prev => !prev);
                                } else {
                                    alert("Processed outputs not ready yet!");
                                }
                            }}
                            disabled={loading || rendering}
                        />
                        Show processed outputs
                    </label>
                    {jobId && <div style={{ fontSize: 13, color: "#666" }}>Job: {jobId}</div>}
                </div>

                {/* Map container */}
                <div
                    style={{
                        display: "flex",
                        width: "100%",
                        height: "600px",
                        border: "1px solid #ccc",
                        position: "relative",
                        pointerEvents: loading ? "none" : "auto",
                    }}
                >
                    <div ref={leftDivRef} style={{ flex: 1, height: "100%" }}></div>
                    <div ref={rightDivRef} style={{ flex: 1, height: "100%" }}></div>
                </div>
            </div>

            {/* Spinner animation keyframes */}
            <style>
                {`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}
            </style>
        </div>
    );

}

export default SplitMapView;