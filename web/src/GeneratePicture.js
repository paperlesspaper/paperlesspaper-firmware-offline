import { ditherImage, spectra6OriginalPalette, replaceColors, suggestCanvasProcessingOptions, getProcessingPresetOptions } from "epdoptimize";
import newProfile from "./profiles/new.json";

export class GeneratePicture {
    constructor() {
        this.epdWidth = 800;
        this.epdHeight = 480;
        this.originalImage = null;
        this.imageRotation = 0;
        this.customPalette = null;
        this.currentDitherOptions = {};
        this.processedImageBuffer = null;
        this.profilePaletteCache = new Map();

        this.SPECTRA_COLOR_INDICES = {
            black: 0,
            blue: 1,
            green: 2,
            red: 3,
            yellow: 5,
            white: 6,
        };

        this.spectra6CustomPalette = [
            { name: "black", color: "#1f2226", deviceColor: "#000000" },
            { name: "white", color: "#d6d6d6", deviceColor: "#FFFFFF" },
            { name: "blue", color: "#416ce1", deviceColor: "#0000FF" },
            { name: "green", color: "#067406", deviceColor: "#00FF00" },
            { name: "red", color: "#ea4843", deviceColor: "#FF0000" },
            { name: "yellow", color: "#dbd529", deviceColor: "#FFFF00" },
        ];
    }

    setEpdDimensions(width, height) {
        this.epdWidth = width;
        this.epdHeight = height;
    }

    setOriginalImage(img) {
        this.originalImage = img;
    }

    getOriginalImage() {
        return this.originalImage;
    }

    setImageRotation(rotation) {
        this.imageRotation = rotation;
    }

    getImageRotation() {
        return this.imageRotation;
    }

    setCustomPalette(palette) {
        this.customPalette = palette;
    }

    getCustomPalette() {
        return this.customPalette;
    }

    setCurrentDitherOptions(options) {
        this.currentDitherOptions = options;
    }

    getCurrentDitherOptions() {
        return this.currentDitherOptions;
    }

    getProcessedImageBuffer() {
        return this.processedImageBuffer;
    }

    getBasePalette(val) {
        if (val === "spectra6Custom") return this.spectra6CustomPalette;
        return spectra6OriginalPalette;
    }

    rgbArrayToHex(rgb) {
        return "#" + rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("");
    }

    matTranspose(A) {
        const rows = A.length, cols = A[0].length;
        const T = [];
        for (let j = 0; j < cols; j++) {
            T[j] = [];
            for (let i = 0; i < rows; i++) T[j][i] = A[i][j];
        }
        return T;
    }

    matMultiply(A, B) {
        const m = A.length, n = B[0].length, p = B.length;
        const C = [];
        for (let i = 0; i < m; i++) {
            C[i] = [];
            for (let j = 0; j < n; j++) {
                let s = 0;
                for (let k = 0; k < p; k++) s += A[i][k] * B[k][j];
                C[i][j] = s;
            }
        }
        return C;
    }

    matInverse(M) {
        const n = M.length;
        const aug = M.map((row, i) => {
            const r = row.slice();
            for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
            return r;
        });
        for (let col = 0; col < n; col++) {
            let maxRow = col, maxVal = Math.abs(aug[col][col]);
            for (let row = col + 1; row < n; row++) {
                if (Math.abs(aug[row][col]) > maxVal) {
                    maxVal = Math.abs(aug[row][col]);
                    maxRow = row;
                }
            }
            [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
            const pivot = aug[col][col];
            if (Math.abs(pivot) < 1e-12) return null;
            for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
            for (let row = 0; row < n; row++) {
                if (row === col) continue;
                const factor = aug[row][col];
                for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
            }
        }
        return aug.map(row => row.slice(n));
    }

    solveAffine(src, dst) {
        const A_aug = src.map(row => [...row, 1]);
        const At = this.matTranspose(A_aug);
        const AtA = this.matMultiply(At, A_aug);
        const AtA_inv = this.matInverse(AtA);
        if (!AtA_inv) return [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]];
        const AtB = this.matMultiply(At, dst);
        return this.matMultiply(AtA_inv, AtB);
    }

    computeLightingMatrix(reference) {
        const patches = reference.filter(p => p.rgb);
        if (patches.length < 4) return null;
        const measured = patches.map(p => (p.measured || p.rgb).map(v => v / 255));
        const trueRGB = patches.map(p => p.rgb.map(v => v / 255));
        return this.solveAffine(measured, trueRGB);
    }

    applyAffineToRGB(rgb, matrix) {
        const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
        return [
            Math.max(0, Math.min(255, Math.round((r * matrix[0][0] + g * matrix[1][0] + b * matrix[2][0] + matrix[3][0]) * 255))),
            Math.max(0, Math.min(255, Math.round((r * matrix[0][1] + g * matrix[1][1] + b * matrix[2][1] + matrix[3][1]) * 255))),
            Math.max(0, Math.min(255, Math.round((r * matrix[0][2] + g * matrix[1][2] + b * matrix[2][2] + matrix[3][2]) * 255))),
        ];
    }

    buildPaletteFromProfile(profile) {
        const cacheKey = profile.name;
        if (this.profilePaletteCache.has(cacheKey)) return this.profilePaletteCache.get(cacheKey);

        const L_inv = profile.data.matrix || this.computeLightingMatrix(profile.data.reference);

        const palette = profile.data.palette.map(p => {
            let colorHex;
            if (p.measured && L_inv) {
                const corrected = this.applyAffineToRGB(p.measured, L_inv);
                colorHex = this.rgbArrayToHex(corrected);
            } else {
                colorHex = p.deviceColor;
            }
            return {
                name: p.id,
                color: colorHex,
                deviceColor: p.deviceColor,
            };
        });

        this.profilePaletteCache.set(cacheKey, palette);
        return palette;
    }

    computeProfileAwareDitherOptions(profile, sourceCanvas) {
        const opts = {
            ditheringType: "errorDiffusion",
            errorDiffusionMatrix: "floydSteinberg",
            serpentine: true,
        };

        const paletteMeasured = profile.data.target;
        if (!paletteMeasured || paletteMeasured.length === 0) return opts;

        const whiteEntry = paletteMeasured.find(p => p.id === "white");
        const blackEntry = paletteMeasured.find(p => p.id === "black");

        let displayWhiteLum = 1.0;
        let displayBlackLum = 0.0;
        if (whiteEntry && whiteEntry.measured) {
            displayWhiteLum = (whiteEntry.measured[0] * 0.299 + whiteEntry.measured[1] * 0.587 + whiteEntry.measured[2] * 0.114) / 255;
        }
        if (blackEntry && blackEntry.measured) {
            displayBlackLum = (blackEntry.measured[0] * 0.299 + blackEntry.measured[1] * 0.587 + blackEntry.measured[2] * 0.114) / 255;
        }

        opts.dynamicRangeCompression = {
            mode: "percentile",
            strength: 0.85,
            lowPercentile: 0.003,
            highPercentile: 0.999,
        };

        opts.colorMatching = "rgb";

        const highlightCompressValue = -1.5 - (0.65 - displayWhiteLum) * 5;
        const clampedHC = Math.max(-3.0, Math.min(-0.5, highlightCompressValue));

        const redEntry = paletteMeasured.find(p => p.id === "red");
        const greenEntry = paletteMeasured.find(p => p.id === "green");
        const blueEntry = paletteMeasured.find(p => p.id === "blue");

        let avgSat = 1.0;
        if (redEntry && redEntry.measured && greenEntry && greenEntry.measured && blueEntry && blueEntry.measured) {
            const getSat = (rgb) => (Math.max(...rgb) - Math.min(...rgb)) / 255.0;
            avgSat = (getSat(redEntry.measured) + getSat(greenEntry.measured) + getSat(blueEntry.measured)) / 3.0;
        }

        const satBoost = Math.max(0, Math.min(0.6, (0.7 - avgSat) * 0.35));

        let exposureVal = 0.05;
        let contrastVal = 0.10;
        let imgSatBoost = 0;

        if (sourceCanvas && sourceCanvas.width > 0 && sourceCanvas.height > 0) {
            const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
            const imgData = ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
            const data = imgData.data;

            let totalLum = 0;
            let totalSat = 0;
            let lums = [];

            const step = 4 * 16;
            let count = 0;
            for (let i = 0; i < data.length; i += step) {
                const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
                const max = Math.max(r, g, b);
                const min = Math.min(r, g, b);
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                const sat = max === 0 ? 0 : (max - min) / max;

                totalLum += lum;
                totalSat += sat;
                lums.push(lum);
                count++;
            }

            if (count > 0) {
                const avgLum = totalLum / count;
                const avgImageSat = totalSat / count;

                lums.sort((a, b) => a - b);
                const p5 = lums[Math.floor(lums.length * 0.05)];
                const p95 = lums[Math.floor(lums.length * 0.95)];
                const dynamicRange = p95 - p5;

                const targetLum = 0.55;
                exposureVal = (targetLum - avgLum) * 0.5;
                exposureVal = Math.max(-0.2, Math.min(0.4, exposureVal));

                const targetRange = 0.8;
                if (dynamicRange < targetRange) {
                    contrastVal = (targetRange - dynamicRange) * 0.6;
                } else {
                    contrastVal = 0.05;
                }
                contrastVal = Math.max(0, Math.min(0.5, contrastVal));

                const targetImgSat = 0.4;
                if (avgImageSat < targetImgSat) {
                    imgSatBoost = (targetImgSat - avgImageSat) * 0.5;
                }
            }
        }

        opts.toneMapping = {
            mode: "scurve",
            strength: 0.9,
            shadowBoost: 0,
            highlightCompress: clampedHC,
            midpoint: 0.5,
            exposure: exposureVal,
            contrast: contrastVal,
            saturation: Math.max(0.15, satBoost) + imgSatBoost,
        };

        return opts;
    }

    hexToRgb(h) {
        const num = parseInt(h.replace("#", ""), 16);
        return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
    }

    getClosestColorIndex(r, g, b, palette, isNewProfile = false) {
        let minDst = Infinity;
        let bestIdx = 6;
        for (const entry of palette) {
            const c = this.hexToRgb(isNewProfile ? entry.deviceColor : entry.color);
            const dst = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
            if (dst < minDst) {
                minDst = dst;
                bestIdx = this.SPECTRA_COLOR_INDICES[entry.name] ?? 6;
            }
        }
        return bestIdx;
    }

    renderDisplayPreview(sourceCanvas, profile, hoverCanvas) {
        if (!profile || !profile.data.palette.every(p => p.measured)) return;
        if (!hoverCanvas) return;

        hoverCanvas.width = sourceCanvas.width;
        hoverCanvas.height = sourceCanvas.height;

        const hCtx = hoverCanvas.getContext("2d", { willReadFrequently: true });
        const srcCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
        const imgData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
        const data = imgData.data;

        const L_inv = profile.data.matrix || this.computeLightingMatrix(profile.data.reference);
        const colorMap = new Map();
        for (const p of profile.data.palette) {
            if (p.measured) {
                const corrected = L_inv ? this.applyAffineToRGB(p.measured, L_inv) : p.measured;
                colorMap.set(p.deviceColor.toUpperCase(), corrected);
            }
        }

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            let minDist = Infinity;
            let bestColor = null;
            for (const [devHex, corrected] of colorMap) {
                const ec = this.hexToRgb(devHex);
                const dist = (r - ec.r) ** 2 + (g - ec.g) ** 2 + (b - ec.b) ** 2;
                if (dist < minDist) {
                    minDist = dist;
                    bestColor = corrected;
                }
            }
            if (bestColor) {
                data[i] = bestColor[0];
                data[i + 1] = bestColor[1];
                data[i + 2] = bestColor[2];
            }
        }

        hCtx.putImageData(imgData, 0, 0);
    }

    drawOriginalToCanvas(targetCtx, targetW = this.epdWidth, targetH = this.epdHeight) {
        if (!this.originalImage) return;

        targetCtx.fillStyle = "white";
        targetCtx.fillRect(0, 0, targetW, targetH);

        const isRotated = this.imageRotation === 90 || this.imageRotation === 270;
        const virtW = isRotated ? this.originalImage.height : this.originalImage.width;
        const virtH = isRotated ? this.originalImage.width : this.originalImage.height;

        let scale = Math.min(targetW / virtW, targetH / virtH);
        let renderW = this.originalImage.width * scale;
        let renderH = this.originalImage.height * scale;

        targetCtx.save();
        targetCtx.translate(targetW / 2, targetH / 2);
        targetCtx.rotate((this.imageRotation * Math.PI) / 180);

        targetCtx.drawImage(this.originalImage, -renderW / 2, -renderH / 2, renderW, renderH);

        targetCtx.restore();
    }

    getActivePalette(paletteSelectValue) {
        if (paletteSelectValue === "new") {
            return this.buildPaletteFromProfile({ name: "new.json", data: newProfile });
        } else {
            return this.customPalette || this.getBasePalette(paletteSelectValue || "spectra6Custom");
        }
    }

    buildDitherOptions(baseOptions, matrix, isSerpentine, colorMode, brightnessInt, contrastInt, saturationInt) {
        const toneMappingMode = brightnessInt !== 0 || contrastInt !== 0 || saturationInt !== 0 ? "contrast" : "off";

        return {
            ...baseOptions,
            ditheringType: "errorDiffusion",
            errorDiffusionMatrix: baseOptions.errorDiffusionMatrix ?? matrix,
            serpentine: baseOptions.serpentine ?? isSerpentine,
            colorMatching: baseOptions.colorMatching ?? colorMode,
            toneMapping: baseOptions.toneMapping || {
                mode: toneMappingMode,
                exposure: brightnessInt / 100,
                contrast: contrastInt / 100,
                saturation: saturationInt / 100,
            },
        };
    }

    async processPreview(canvas, hoverCanvas, paletteSelectValue, matrix, isSerpentine, brightnessInt, contrastInt, saturationInt, optionsOverrides = {}) {
        if (!this.originalImage) return;

        const isPaperL = (this.epdWidth === 1200 && this.epdHeight === 1600);
        const scaleRatio = isPaperL ? 0.5 : 1.0;

        const previewW = Math.floor(this.epdWidth * scaleRatio);
        const previewH = Math.floor(this.epdHeight * scaleRatio);

        canvas.width = previewW;
        canvas.height = previewH;

        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        this.drawOriginalToCanvas(ctx, previewW, previewH);

        const activePalette = this.getActivePalette(paletteSelectValue);
        const ditherOptions = this.buildDitherOptions(optionsOverrides, matrix, isSerpentine, "rgb", brightnessInt, contrastInt, saturationInt);
        this.currentDitherOptions = optionsOverrides; // store base options overrides like in app.js

        await ditherImage(canvas, canvas, {
            ...ditherOptions,
            palette: activePalette,
        });

        const isNew = (paletteSelectValue === "new");
        if (isNew) {
            replaceColors(canvas, canvas, activePalette);
            this.renderDisplayPreview(canvas, { name: "new.json", data: newProfile }, hoverCanvas);
            if (hoverCanvas) hoverCanvas.style.opacity = "1";
        } else {
            if (hoverCanvas) {
                hoverCanvas.getContext("2d").clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);
                hoverCanvas.style.opacity = "0";
            }
        }
    }

    async generateFullBuffer(paletteSelectValue, matrix, isSerpentine, brightnessInt, contrastInt, saturationInt, optionsOverrides = {}) {
        if (!this.originalImage) return;

        const fullCanvas = document.createElement("canvas");
        fullCanvas.width = this.epdWidth;
        fullCanvas.height = this.epdHeight;
        const fullCtx = fullCanvas.getContext("2d", { willReadFrequently: true });

        this.drawOriginalToCanvas(fullCtx, this.epdWidth, this.epdHeight);

        const activePalette = this.getActivePalette(paletteSelectValue);
        const ditherOptions = this.buildDitherOptions(optionsOverrides, matrix, isSerpentine, "rgb", brightnessInt, contrastInt, saturationInt);

        await ditherImage(fullCanvas, fullCanvas, {
            ...ditherOptions,
            palette: activePalette,
        });

        const isNew = (paletteSelectValue === "new");
        if (isNew) {
            replaceColors(fullCanvas, fullCanvas, activePalette);
        }

        const ditheredData = fullCtx.getImageData(0, 0, this.epdWidth, this.epdHeight);
        let ditheredRaw = ditheredData.data;
        let outputCount = Math.ceil((this.epdWidth * this.epdHeight) / 2);
        this.processedImageBuffer = new Uint8Array(outputCount);

        for (let y = 0; y < this.epdHeight; y++) {
            for (let x = 0; x < this.epdWidth; x++) {
                let i = (y * this.epdWidth + x) * 4;
                let r = ditheredRaw[i],
                    g = ditheredRaw[i + 1],
                    b = ditheredRaw[i + 2];

                let colorIndex = this.getClosestColorIndex(r, g, b, activePalette, isNew);

                let outIdx = Math.floor((y * this.epdWidth + x) / 2);
                if (x % 2 === 0) this.processedImageBuffer[outIdx] = colorIndex << 4;
                else this.processedImageBuffer[outIdx] |= colorIndex;
            }
        }
    }

    autoOptimise(canvas, paletteSelectValue) {
        if (!this.originalImage) return null;

        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        this.drawOriginalToCanvas(ctx, canvas.width, canvas.height);

        if (paletteSelectValue === "new") {
            const resolvedOptions = this.computeProfileAwareDitherOptions({ name: "new.json", data: newProfile }, canvas);
            return resolvedOptions;
        }

        const activePalette = this.getActivePalette(paletteSelectValue);

        const suggestion = suggestCanvasProcessingOptions(canvas, activePalette, {
            intent: "natural",
        });

        if (suggestion && suggestion.ditherOptions) {
            let resolvedOptions = suggestion.ditherOptions;
            if (resolvedOptions.processingPreset) {
                const presetValues = getProcessingPresetOptions(resolvedOptions.processingPreset);
                resolvedOptions = { ...presetValues, ...resolvedOptions };
            }
            delete resolvedOptions.processingPreset;
            return { resolvedOptions, suggestion };
        }
        return null;
    }
}
