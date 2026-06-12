import { multiply, inv, transpose } from 'mathjs';
import { ditherImage, spectra6OriginalPalette } from 'epdoptimize';

const SPYDER_SRGB = [
  // Row 1
  { name: '1E Card White', rgb: [249, 242, 238] },
  { name: '1F Primary Cyan', rgb: [0, 127, 159] },
  { name: '1G Primary Orange', rgb: [222, 118, 32] },
  { name: '1H Aqua', rgb: [98, 187, 166] },
  // Row 2
  { name: '2E 20% Gray', rgb: [202, 198, 195] },
  { name: '2F Primary Magenta', rgb: [192, 75, 145] },
  { name: '2G Blueprint', rgb: [58, 88, 159] },
  { name: '2H Lavender', rgb: [126, 125, 174] },
  // Row 3
  { name: '3E 40% Gray', rgb: [161, 157, 154] },
  { name: '3F Primary Yellow', rgb: [245, 205, 0] },
  { name: '3G Pink', rgb: [195, 79, 95] },
  { name: '3H Evergreen', rgb: [82, 106, 60] },
  // Row 4
  { name: '4E 60% Gray', rgb: [122, 118, 116] },
  { name: '4F Primary Red', rgb: [186, 26, 51] },
  { name: '4G Violet', rgb: [83, 58, 106] },
  { name: '4H Steel Blue', rgb: [87, 120, 155] },
  // Row 5
  { name: '5E 80% Gray', rgb: [80, 80, 78] },
  { name: '5F Primary Green', rgb: [57, 146, 64] },
  { name: '5G Apple Green', rgb: [157, 188, 54] },
  { name: '5H Classic Light Skin', rgb: [197, 145, 125] },
  // Row 6
  { name: '6E Card Black', rgb: [43, 41, 43] },
  { name: '6F Primary Blue', rgb: [25, 55, 135] },
  { name: '6G Sunflower', rgb: [238, 158, 25] },
  { name: '6H Classic Dark Skin', rgb: [112, 76, 60] }
];

let state = {
    reference: SPYDER_SRGB.map(p => ({ ...p, measured: null })),
    target: SPYDER_SRGB.map(p => ({ ...p, measured: null })),
    palette: [
        { id: 'black', name: 'Schwarz', deviceColor: '#000000', measured: null },
        { id: 'white', name: 'Weiß', deviceColor: '#FFFFFF', measured: null },
        { id: 'blue', name: 'Blau', deviceColor: '#0000FF', measured: null },
        { id: 'green', name: 'Grün', deviceColor: '#00FF00', measured: null },
        { id: 'red', name: 'Rot', deviceColor: '#FF0000', measured: null },
        { id: 'yellow', name: 'Gelb', deviceColor: '#FFFF00', measured: null },
    ],
    activeType: null, // 'reference', 'target', 'palette'
    activeIndex: -1,
    zoom: 1,
    imageObj: null,
    previewImageObj: null,
    calculatedMatrix: null
};

// UI Elements
const els = {
    imageUpload: document.getElementById('imageUpload'),
    canvas: document.getElementById('imageCanvas'),
    canvasInner: document.getElementById('canvasInner'),
    wrapper: document.getElementById('canvasWrapper'),
    selBox: document.getElementById('selectionBox'),
    listReference: document.getElementById('listReference'),
    listTarget: document.getElementById('listTarget'),
    listPalette: document.getElementById('listPalette'),
    colorPreview: document.getElementById('colorPreview'),
    colorRgb: document.getElementById('colorRgb'),
    btnAssign: document.getElementById('btnAssignColor'),
    zoomLevel: document.getElementById('zoomLevel'),
    btnZoomIn: document.getElementById('btnZoomIn'),
    btnZoomOut: document.getElementById('btnZoomOut'),
    btnCalculate: document.getElementById('btnCalculate'),
    useStandardSrgb: document.getElementById('useStandardSrgb'),
    profileStats: document.getElementById('profileStats'),
    testImageCanvas: document.getElementById('testImageCanvas'),
    btnDownloadTestImage: document.getElementById('btnDownloadTestImage'),
    btnSave: document.getElementById('btnSave'),
    btnLoad: document.getElementById('btnLoad'),
    loadJson: document.getElementById('loadJson'),
    btnGenerateRef: document.getElementById('btnGenerateRef'),
    tooltip: document.getElementById('cursorTooltip'),
    tooltipSwatch: document.getElementById('cursorColorSwatch'),
    tooltipName: document.getElementById('cursorColorName')
};

let ctx = els.canvas.getContext('2d', { willReadFrequently: true });
let isDragging = false;
let startX, startY, currentX, currentY;
let currentAverageColor = null;

function rgbToHex(r, g, b) {
    if (Array.isArray(r)) { b = r[2]; g = r[1]; r = r[0]; }
    return "#" + (1 << 24 | Math.round(r) << 16 | Math.round(g) << 8 | Math.round(b)).toString(16).slice(1);
}

function updateUI() {
    // Render Reference List
    const useStd = els.useStandardSrgb.checked;
    els.listReference.innerHTML = '';
    state.reference.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = `patch-item ${state.activeType === 'reference' && state.activeIndex === i ? 'active' : ''} ${(useStd || item.measured) ? 'completed' : ''}`;
        if (useStd) div.style.opacity = '0.5';
        
        let colorObj = useStd ? item.rgb : (item.measured || null);
        let colorStr = colorObj ? `rgb(${colorObj[0]}, ${colorObj[1]}, ${colorObj[2]})` : 'transparent';
        
        div.innerHTML = `
            <span>${item.name}</span>
            <div class="patch-color-preview" style="background-color: ${colorStr}"></div>
        `;
        div.onclick = () => {
            if (!useStd) setActive('reference', i);
        };
        els.listReference.appendChild(div);
    });

    // Render Target List
    els.listTarget.innerHTML = '';
    state.target.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = `patch-item ${state.activeType === 'target' && state.activeIndex === i ? 'active' : ''} ${item.measured ? 'completed' : ''}`;
        let colorObj = item.measured;
        let colorStr = colorObj ? `rgb(${colorObj[0]}, ${colorObj[1]}, ${colorObj[2]})` : 'transparent';
        
        div.innerHTML = `
            <span>${item.name}</span>
            <div class="patch-color-preview" style="background-color: ${colorStr}"></div>
        `;
        div.onclick = () => setActive('target', i);
        els.listTarget.appendChild(div);
    });

    // Render Palette List
    els.listPalette.innerHTML = '';
    state.palette.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = `patch-item ${state.activeType === 'palette' && state.activeIndex === i ? 'active' : ''} ${item.measured ? 'completed' : ''}`;
        let colorObj = item.measured;
        let colorStr = colorObj ? `rgb(${colorObj[0]}, ${colorObj[1]}, ${colorObj[2]})` : 'transparent';
        
        div.innerHTML = `
            <span>${item.name}</span>
            <div class="patch-color-preview" style="background-color: ${colorStr}"></div>
        `;
        div.onclick = () => setActive('palette', i);
        els.listPalette.appendChild(div);
    });

    els.useStandardSrgb.onchange = () => updateUI();

    // Check if we can calculate
    let refReady = useStd || state.reference.every(p => p.measured);
    let targetReady = state.target.every(p => p.measured);
    let palReady = state.palette.every(p => p.measured);
    els.btnCalculate.disabled = !(refReady && targetReady && palReady);
}

function setActive(type, index) {
    state.activeType = type;
    state.activeIndex = index;
    updateUI();
}

els.imageUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            // Auto-fit image to workspace BEFORE setting canvas width
            const wrapperRect = els.wrapper.getBoundingClientRect();
            const availableW = wrapperRect.width - 32;
            const availableH = wrapperRect.height - 32;
            const zoomW = availableW / img.width;
            const zoomH = availableH / img.height;
            state.zoom = Math.min(1, zoomW, zoomH);

            state.imageObj = img;
            els.canvas.width = img.width;
            els.canvas.height = img.height;

            if (state.activeType === null) setActive('target', 0);

            drawImage();
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
});

function drawImage() {
    if (!state.imageObj) return;
    
    els.canvasInner.style.transform = ''; // remove old transform
    
    const scaledW = state.imageObj.width * state.zoom;
    const scaledH = state.imageObj.height * state.zoom;
    
    els.canvas.style.width = `${scaledW}px`;
    els.canvas.style.height = `${scaledH}px`;
    els.canvasInner.style.width = `${scaledW}px`;
    els.canvasInner.style.height = `${scaledH}px`;

    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    ctx.drawImage(state.imageObj, 0, 0);
    
    // Apply Matrix Preview
    if (els.toggleMatrix.checked && state.matrix) {
        const imgData = ctx.getImageData(0, 0, els.canvas.width, els.canvas.height);
        const data = imgData.data;
        const M = state.matrix; // 4x3 matrix
        
        const m00 = M[0][0], m01 = M[0][1], m02 = M[0][2];
        const m10 = M[1][0], m11 = M[1][1], m12 = M[1][2];
        const m20 = M[2][0], m21 = M[2][1], m22 = M[2][2];
        const m30 = M[3][0], m31 = M[3][1], m32 = M[3][2];
        
        for (let i = 0; i < data.length; i += 4) {
            let r = data[i] / 255;
            let g = data[i+1] / 255;
            let b = data[i+2] / 255;
            
            data[i]   = (r * m00 + g * m10 + b * m20 + m30) * 255;
            data[i+1] = (r * m01 + g * m11 + b * m21 + m31) * 255;
            data[i+2] = (r * m02 + g * m12 + b * m22 + m32) * 255;
        }
        ctx.putImageData(imgData, 0, 0);
    }

    els.zoomLevel.innerText = `${Math.round(state.zoom * 100)}%`;
}

els.btnZoomIn.onclick = () => { state.zoom *= 1.25; drawImage(); };
els.btnZoomOut.onclick = () => { state.zoom *= 0.8; drawImage(); };

// Mouse Events for Canvas
els.canvasInner.addEventListener('mousedown', (e) => {
    if (!state.imageObj) return;
    const rect = els.canvasInner.getBoundingClientRect();
    startX = (e.clientX - rect.left) / state.zoom;
    startY = (e.clientY - rect.top) / state.zoom;
    isDragging = true;
    els.selBox.style.display = 'block';
    updateSelectionBox(e);
});

els.canvasInner.addEventListener('mousemove', (e) => {
    // Tooltip logic
    if (state.activeType !== null && state.activeIndex >= 0) {
        let item;
        let colorStr = 'transparent';
        if (state.activeType === 'reference' || state.activeType === 'target') {
            item = state[state.activeType][state.activeIndex];
            let rgb = SPYDER_SRGB[state.activeIndex].rgb;
            colorStr = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        } else if (state.activeType === 'palette') {
            item = state.palette[state.activeIndex];
            colorStr = item.deviceColor;
        }

        if (item) {
            els.tooltipName.innerText = item.name;
            els.tooltipSwatch.style.backgroundColor = colorStr;
            els.tooltip.style.left = `${e.clientX}px`;
            els.tooltip.style.top = `${e.clientY - 20}px`;
            els.tooltip.style.display = 'flex';
        }
    } else {
        els.tooltip.style.display = 'none';
    }

    if (!isDragging || !state.imageObj) return;
    updateSelectionBox(e);
});

els.canvasInner.addEventListener('mouseup', (e) => {
    if (!isDragging || !state.imageObj) return;
    isDragging = false;
    calculateAverageColor();
    
    // Auto assign
    if (!els.btnAssign.disabled) {
        els.btnAssign.click();
    }
    setTimeout(() => { els.selBox.style.display = 'none'; }, 200);
});

els.canvasInner.addEventListener('mouseleave', () => {
    els.tooltip.style.display = 'none';
    if (isDragging) {
        isDragging = false;
        calculateAverageColor();
        if (!els.btnAssign.disabled) els.btnAssign.click();
        setTimeout(() => { els.selBox.style.display = 'none'; }, 200);
    }
});

function updateSelectionBox(e) {
    const rect = els.canvasInner.getBoundingClientRect();
    currentX = (e.clientX - rect.left) / state.zoom;
    currentY = (e.clientY - rect.top) / state.zoom;

    const x = Math.min(startX, currentX) * state.zoom;
    const y = Math.min(startY, currentY) * state.zoom;
    const w = Math.abs(currentX - startX) * state.zoom;
    const h = Math.abs(currentY - startY) * state.zoom;

    els.selBox.style.left = `${x}px`;
    els.selBox.style.top = `${y}px`;
    els.selBox.style.width = `${w}px`;
    els.selBox.style.height = `${h}px`;
}

function calculateAverageColor() {
    const x = Math.floor(Math.min(startX, currentX));
    const y = Math.floor(Math.min(startY, currentY));
    const w = Math.floor(Math.abs(currentX - startX));
    const h = Math.floor(Math.abs(currentY - startY));

    if (w < 1 || h < 1) {
        els.btnAssign.disabled = true;
        return;
    }

    const imgData = ctx.getImageData(x, y, w, h);
    const data = imgData.data;
    let r = 0, g = 0, b = 0;
    const count = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
    }

    r = Math.round(r / count);
    g = Math.round(g / count);
    b = Math.round(b / count);

    currentAverageColor = [r, g, b];
    els.colorPreview.style.backgroundColor = `rgb(${r},${g},${b})`;
    els.colorRgb.innerText = `RGB: ${r}, ${g}, ${b}`;
    els.btnAssign.disabled = false;
}

els.btnAssign.onclick = () => {
    if (!currentAverageColor || state.activeType === null) return;
    
    if (state.activeType === 'reference') {
        state.reference[state.activeIndex].measured = currentAverageColor;
    } else if (state.activeType === 'target') {
        state.target[state.activeIndex].measured = currentAverageColor;
    } else if (state.activeType === 'palette') {
        state.palette[state.activeIndex].measured = currentAverageColor;
    }

    // Auto-advance
    let arr = state[state.activeType];
    if (state.activeIndex < arr.length - 1) {
        state.activeIndex++;
    } else {
        // Try to jump to next category
        if (state.activeType === 'reference' && !els.useStandardSrgb.checked) setActive('target', 0);
        else if (state.activeType === 'target') setActive('palette', 0);
        else setActive(null, -1);
    }
    updateUI();
};

function solveAffine(A, B) {
    // Append 1 to each row in A for the intercept (offset)
    const A_aug = A.map(row => [...row, 1]);
    const At = transpose(A_aug);
    const AtA = multiply(At, A_aug);
    const AtA_inv = inv(AtA);
    const AtB = multiply(At, B);
    return multiply(AtA_inv, AtB); // Returns 4x3 matrix
}

function normalizeRGB(arr) {
    return arr.map(row => row.map(v => v / 255.0));
}

// Math & Calculation
els.btnCalculate.onclick = () => {
    try {
        for(let i=0; i<24; i++) {
            if (!state.target[i].measured) return alert('Bitte alle 24 Felder auf dem Display (Target) abmessen.');
        }
        
        const useStd = els.useStandardSrgb.checked;
        if (!useStd) {
            for(let i=0; i<24; i++) {
                if (!state.reference[i].measured) return alert('Bitte alle 24 Felder auf dem Foto (Reference) abmessen.');
            }
        }

        // Normalize inputs to 0-1 range
        let Display_Meas = normalizeRGB(state.target.map(t => t.measured));
        let Ref_Theo = normalizeRGB(SPYDER_SRGB.map(t => t.rgb));
        let Ref_Meas = normalizeRGB(state.reference.map(t => t.measured || [0,0,0]));

        // 1. Lighting correction L_inv (4x3 matrix)
        let L_inv;
        if (!useStd) {
            // Ref_Meas * L_inv = Ref_Theo
            L_inv = solveAffine(Ref_Meas, Ref_Theo);
        } else {
            L_inv = [[1,0,0],[0,1,0],[0,0,1],[0,0,0]]; // Identity 4x3
        }

        // 2. Correct Display colors for lighting
        const Display_Meas_aug = Display_Meas.map(row => [...row, 1]);
        const True_Display = multiply(Display_Meas_aug, L_inv); // N x 3

        // 3. Compute Image Correction Matrix M_apply (4x3 matrix)
        // To PREVENT pure colors (like [0,0,255]) from turning purple due to extrapolation
        // and cross-talk, we calculate a PURE GAIN matrix (no offsets, no cross-channel mixing).
        // Gain = sum(True * Theo) / sum(True^2)
        let sum_R_true2 = 0, sum_R_true_theo = 0;
        let sum_G_true2 = 0, sum_G_true_theo = 0;
        let sum_B_true2 = 0, sum_B_true_theo = 0;
        
        for (let i = 0; i < True_Display.length; i++) {
            let tr = True_Display[i][0], tg = True_Display[i][1], tb = True_Display[i][2];
            let rr = Ref_Theo[i][0], rg = Ref_Theo[i][1], rb = Ref_Theo[i][2];
            
            sum_R_true2 += tr * tr; sum_R_true_theo += tr * rr;
            sum_G_true2 += tg * tg; sum_G_true_theo += tg * rg;
            sum_B_true2 += tb * tb; sum_B_true_theo += tb * rb;
        }
        
        const gain_R = sum_R_true_theo / (sum_R_true2 || 1);
        const gain_G = sum_G_true_theo / (sum_G_true2 || 1);
        const gain_B = sum_B_true_theo / (sum_B_true2 || 1);

        const M_apply = [
            [gain_R, 0, 0],
            [0, gain_G, 0],
            [0, 0, gain_B],
            [0, 0, 0] // No offsets!
        ];
        
        state.matrix = M_apply; // Save the 4x3 matrix

        // 4. Correct Palette
        let outPalette = [];
        let stateTruePalette = [];
        state.palette.forEach(p => {
            // The user requested to dither using the PURE colors, because the full affine matrix
            // already shifts the entire image into the display's color space.
            outPalette.push(`    { name: "${p.id}", color: "${p.deviceColor}", deviceColor: "${p.deviceColor}" }`);
            stateTruePalette.push({ id: p.id, hex: p.deviceColor });
        });
        state.truePalette = stateTruePalette;

        renderProfileStats(M_apply);
        
    } catch (err) {
        alert("Fehler bei der Matrixberechnung: " + err.message);
        console.error(err);
    }
};

function renderProfileStats(M) {
    if (!els.profileStats) return;
    if (!M) {
        els.profileStats.innerText = 'Bitte zunächst alle Felder markieren und auf "Profil berechnen" klicken.';
        return;
    }
    
    let mFlat = [];
    for(let r=0; r<4; r++) {
        for(let c=0; c<3; c++) {
            mFlat.push(M[r][c].toFixed(4));
        }
    }
    
    els.profileStats.innerText = [
        "Gain Matrix (RGB):",
        "R-Einfluss: [" + mFlat[0] + ", " + mFlat[1] + ", " + mFlat[2] + "]",
        "G-Einfluss: [" + mFlat[3] + ", " + mFlat[4] + ", " + mFlat[5] + "]",
        "B-Einfluss: [" + mFlat[6] + ", " + mFlat[7] + ", " + mFlat[8] + "]",
        "Offsets:    [" + mFlat[9] + ", " + mFlat[10] + ", " + mFlat[11] + "]"
    ].join("\n");
}



// Save/Load Project state
els.btnSave.onclick = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state));
    const a = document.createElement('a');
    a.href = dataStr;
    a.download = "profiler_state.json";
    a.click();
};

els.btnLoad.onclick = () => els.loadJson.click();
els.loadJson.onchange = (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const loaded = JSON.parse(ev.target.result);
            state.reference = loaded.reference || state.reference;
            state.target = loaded.target || state.target;
            state.palette = loaded.palette || state.palette;
            updateUI();
            
            // Auto-calculate if target measurements exist
            if (state.target && state.target[0] && state.target[0].measured) {
                els.btnCalculate.onclick();
            } else {
                alert("Projekt erfolgreich geladen.");
            }
        } catch(err) {
            alert("Fehler beim Laden der Datei.");
        }
    };
    reader.readAsText(file);
};

// Generate Reference Image
els.btnGenerateRef.onclick = async () => {
    try {
        els.btnGenerateRef.innerText = "Berechne Dithering...";
        els.btnGenerateRef.disabled = true;

        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = 800;
        offscreenCanvas.height = 480;
        const tctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
        
        tctx.fillStyle = '#ffffff';
        tctx.fillRect(0, 0, 800, 480);
        
        const patchW = 100;
        const patchH = 105;
        const gap = 10;
        
        const startX = 15;
        const startY = 15; 

        for(let r=0; r<4; r++) {
            for(let c=0; c<6; c++) {
                let orig_row = c;
                let orig_col = r;
                let idx = orig_row * 4 + orig_col;
                
                let rgb = SPYDER_SRGB[idx].rgb;
                tctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
                tctx.fillRect(startX + c*(patchW+gap), startY + r*(patchH+gap), patchW, patchH);
            }
        }

        const palStartX = startX + 6*patchW + 5*gap + 20;
        const palW = 100;
        const palH = 68;
        const palGap = 10;
        const palY = 11;
        
        const paletteHex = ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00'];
        for(let i=0; i<6; i++) {
            tctx.fillStyle = paletteHex[i];
            tctx.fillRect(palStartX, palY + i*(palH+palGap), palW, palH);
            tctx.strokeStyle = '#000000';
            tctx.lineWidth = 2;
            tctx.strokeRect(palStartX, palY + i*(palH+palGap), palW, palH);
        }

        await ditherImage(offscreenCanvas, offscreenCanvas, {
            palette: spectra6OriginalPalette,
            ditheringType: 'errorDiffusion',
            colorMatching: 'rgb',
            errorDiffusionMatrix: 'floydSteinberg',
            serpentine: true
        });

        const W = 800, H = 480;
        const SPECTRA_COLOR_INDICES = { "black": 0, "white": 6, "green": 2, "blue": 1, "red": 3, "yellow": 5 };
        function hexToRgb(hex) {
            let bigint = parseInt(hex.slice(1), 16);
            return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
        }
        function getClosestColorIndex(r, g, b) {
            let minDst = Infinity, bestIdx = 6;
            for (const entry of spectra6OriginalPalette) {
                const c = hexToRgb(entry.color);
                const dst = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
                if (dst < minDst) {
                    minDst = dst;
                    bestIdx = SPECTRA_COLOR_INDICES[entry.name] ?? 6;
                }
            }
            return bestIdx;
        }

        const ditheredData = tctx.getImageData(0, 0, W, H);
        let ditheredRaw = ditheredData.data;
        let outputCount = Math.ceil((W * H) / 2);
        let processedImageBuffer = new Uint8Array(outputCount);
        
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let i = (y * W + x) * 4;
                let colorIndex = getClosestColorIndex(ditheredRaw[i], ditheredRaw[i+1], ditheredRaw[i+2]);
                let outIdx = Math.floor((y * W + x) / 2);
                if (x % 2 === 0) processedImageBuffer[outIdx] = colorIndex << 4;
                else processedImageBuffer[outIdx] |= colorIndex;
            }
        }

        const headerSize = 118;
        const bufferSize = processedImageBuffer.length;
        const fileSize = headerSize + bufferSize;
        const bmpBuffer = new ArrayBuffer(fileSize);
        const view = new DataView(bmpBuffer);
        const bytes = new Uint8Array(bmpBuffer);

        view.setUint8(0, 0x42);
        view.setUint8(1, 0x4d);
        view.setUint32(2, fileSize, true);
        view.setUint32(10, headerSize, true);

        view.setUint32(14, 40, true);
        view.setInt32(18, W, true);
        view.setInt32(22, -H, true);
        view.setUint16(26, 1, true);
        view.setUint16(28, 4, true);
        view.setUint32(30, 0, true);
        view.setUint32(34, bufferSize, true);

        const FIRMWARE_PALETTE = [
            { id: "black", r: 0, g: 0, b: 0 },
            { id: "blue", r: 0, g: 0, b: 255 },
            { id: "green", r: 0, g: 255, b: 0 },
            { id: "red", r: 255, g: 0, b: 0 },
            { id: "unused1", r: 0, g: 0, b: 0 },
            { id: "yellow", r: 255, g: 255, b: 0 },
            { id: "white", r: 255, g: 255, b: 255 }
        ];
        for (let i = 0; i < 16; i++) {
            let pIdx = 54 + i * 4;
            if (i < FIRMWARE_PALETTE.length) {
                view.setUint8(pIdx, FIRMWARE_PALETTE[i].b);
                view.setUint8(pIdx + 1, FIRMWARE_PALETTE[i].g);
                view.setUint8(pIdx + 2, FIRMWARE_PALETTE[i].r);
            }
            view.setUint8(pIdx + 3, 0);
        }

        bytes.set(processedImageBuffer, headerSize);

        const blob = new Blob([bmpBuffer], { type: "image/bmp" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "epaper_testbild_kalibrierung.bmp";
        a.click();
        URL.revokeObjectURL(url);
        
    } catch(e) {
        console.error("Dithering failed", e);
        alert("Fehler beim Generieren des Testbilds.");
    } finally {
        els.btnGenerateRef.innerText = "Testbild herunterladen";
        els.btnGenerateRef.disabled = false;
    }
};

// Init
updateUI();
