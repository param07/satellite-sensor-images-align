import React, { useState } from "react";

const API_BASE = "http://localhost:8080/api";

function UploadPanel({ setImageA, setImageB }) {
    const [uploadingA, setUploadingA] = useState(false);
    const [uploadingB, setUploadingB] = useState(false);
    const uploadFile = async (file, setter, setUploading) => {
        if (!file) return;
        setUploading(true);
        try {
            const formData = new FormData();
            formData.append("file", file);

            const res = await fetch(`${API_BASE}/upload`, {
                method: "POST",
                body: formData
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || `Upload failed: ${res.status}`);
            }

            const data = await res.json();
            setter(data);
        } catch (err) {
            console.error("Upload failed", err);
            alert("Upload failed: " + (err.message || err));
        } finally {
            setUploading(false);
        }
    };
    return (
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <div>
                <label>Image A (left)</label><br />
                <input
                    type="file"
                    accept=".tif,.tiff"
                    onChange={(e) => uploadFile(e.target.files[0], setImageA, setUploadingA)}
                    disabled={uploadingA}
                />
                {uploadingA && <div>Uploading A...</div>}
            </div>
            <div>
                <label>Image B (right)</label><br />
                <input
                    type="file"
                    accept=".tif,.tiff"
                    onChange={(e) => uploadFile(e.target.files[0], setImageB, setUploadingB)}
                    disabled={uploadingB}
                />
                {uploadingB && <div>Uploading B...</div>}
            </div>
        </div>
    );
}

export default UploadPanel;