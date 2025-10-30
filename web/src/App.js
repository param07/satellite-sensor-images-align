import './App.css';
import React, { useState } from "react";
import UploadPanel from './components/UploadPanel';
import SplitMapView from './components/SplitMapView';

function App() {
  const [imageA, setImageA] = useState(null);
  const [imageB, setImageB] = useState(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "12px" }}>
      <h2>EO/SAR Split-View Demo</h2>
      <UploadPanel
        setImageA={setImageA}
        setImageB={setImageB}
      />

      <div style={{ marginTop: 12 }}>
        <strong>Uploaded:</strong>
        <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
          <div>A: {imageA ? `${imageA.filename} (${(imageA.size / 1024 | 0)} KB)` : "No file"}</div>
          <div>B: {imageB ? `${imageB.filename} (${(imageB.size / 1024 | 0)} KB)` : "No file"}</div>
        </div>
      </div>

      {imageA && imageB && (
        <div style={{ marginTop: 20 }}>
          <SplitMapView imageA={imageA} imageB={imageB} />
        </div>
      )}

    </div>
  );
}

export default App;
